/**
 * `agent-billboard-mcp report [dir]`: the agent's own record from its own
 * logs, offline. Reads the activity log (`billboard-activity.jsonl`, or with
 * `--sandbox` `billboard-sandbox-activity.jsonl`), plus `logs/wake.log` and
 * `logs/runner.log` when they exist. Never reads the keypair and makes no
 * network call: the wallet is `billboard_after.poster` on the agent's own
 * executed acquisitions.
 *
 * What it computes, all in lamports as `bigint`:
 *   acquisitions     every executed `acquire_posting_rights` with a bid: the
 *                    minimum at that moment (`minimumBid(billboard_before)`)
 *                    and the premium paid over it, in hundredths of a percent
 *   price signature  min / median / max premium and one sentence
 *   paid back        for each `outbid_detected`: the stake plus half the
 *                    increase (`splitOnAcquire`), and how long the message
 *                    held, from its acquisition to the moment the outbid was
 *                    noticed
 *   now              the last acquisition with no outbid after it
 *   totals           staked, paid back, net
 *   decisions        wake.log by decision, the last ten; runner.log gate skips
 *   refusals         `refused_limit`, `expired`, `superseded`
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ReportArgs } from '../cli.js';
import { DEFAULT_ACTIVITY_LOG_PATH } from '../config.js';
import { ActivityLog, type ActivityEntry } from '../log/activity.js';
import { lamportsToSol, minimumBid, solToLamports, splitOnAcquire } from '../program/math.js';
import { ACQUIRE_TOOL } from '../tools/acquire_posting_rights.js';
import { PACKAGE_NAME } from '../version.js';
import { agentPaths, readEnvFile, type AgentPaths } from './folder.js';

/** Printed (text form) when no log holds anything for this kind of report. */
export const NO_ACTIVITY = 'No activity yet.';

/** How many decisions the report lists. */
export const LAST_DECISIONS = 10;

/** The runner.log events that are the affordability gate holding a wake back. */
export const GATE_EVENTS = [
  'priced_out',
  'waiting_for_budget',
  'unfunded',
  'skipped_poster',
] as const;
export type GateEvent = (typeof GATE_EVENTS)[number];

const GATE_LABEL: Record<GateEvent, string> = {
  priced_out: 'priced out',
  waiting_for_budget: 'waiting for budget',
  unfunded: 'unfunded',
  skipped_poster: 'already the poster',
};

export class ReportError extends Error {
  override readonly name = 'ReportError';
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// The report object (also the --json form)
// ---------------------------------------------------------------------------

export interface ReportAcquisition {
  ts: string;
  bid_sol: string;
  /** The minimum bid at that moment: `minimumBid(billboard_before.amount)`. */
  minimum_sol: string;
  /** Premium over the minimum in percent, up to two decimals. null over an empty board (minimum 0). */
  premium_pct: string | null;
  tx: string | null;
  proposal_id: string | null;
  reasoning: string | null;
}

export interface ReportPayback {
  /** When the outbid was noticed (the log entry's time). */
  ts: string;
  /** The poster who outbid this agent. */
  by: string;
  stake_sol: string;
  /** The board amount after the outbid. */
  outbid_at_sol: string;
  /** Stake plus half the increase. null when the logged amounts are not a valid outbid. */
  paid_back_sol: string | null;
  /** The half of the increase that came back on top of the stake. */
  gain_sol: string | null;
  /** The acquisition this outbid ended, when the log has it. */
  acquired_ts: string | null;
  /** From that acquisition to the outbid being noticed, in seconds. */
  held_s: number | null;
}

export interface PriceSignature {
  count: number;
  min_pct: string | null;
  median_pct: string | null;
  max_pct: string | null;
  sentence: string | null;
}

export interface ReportNow {
  on_board: boolean;
  stake_sol: string | null;
  since: string | null;
}

export interface ReportTotals {
  staked_sol: string;
  paid_back_sol: string;
  /** paid back minus staked; negative is money out. */
  net_sol: string;
  /** The part of `staked_sol` still on the board. */
  on_board_sol: string;
}

export interface ReportWake {
  ts: string;
  trigger: string;
  decision: string;
  reason: string | null;
  next_look_hours: number | null;
  timed_out: boolean;
  exit_code: number | null;
}

export interface ReportDecisions {
  wakes: number;
  by_decision: Record<string, number>;
  /** The last ten, oldest first. */
  last: ReportWake[];
  /** Gate holds from runner.log; each is logged once per board state. */
  gate_skips: number;
  gate_by_reason: Record<GateEvent, number>;
}

export interface ReportRefusal {
  ts: string;
  tool: string;
  bid_sol: string | null;
  proposal_id: string | null;
  /** refused_limit: why; superseded: the proposal that replaced it. */
  detail: string | null;
}

export interface Report {
  folder: string;
  sandbox: boolean;
  /** True when no log holds anything for this kind of report. */
  empty: boolean;
  /** This agent's wallet(s), from its own acquisitions and outbids. */
  wallets: string[];
  acquisitions: ReportAcquisition[];
  price_signature: PriceSignature;
  paid_back: ReportPayback[];
  now: ReportNow;
  totals: ReportTotals;
  decisions: ReportDecisions;
  refusals: {
    refused_limit: ReportRefusal[];
    expired: ReportRefusal[];
    superseded: ReportRefusal[];
  };
  /** Wakes of the other kind (sandbox in a live report, live in a sandbox one), counted only. */
  other_wakes: number;
  /** Log lines that could not be read and were left out. */
  skipped_lines: number;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/**
 * Premium of `bid` over `minimum` in hundredths of a percent, rounded half
 * up: `round((bid - minimum) * 10000 / minimum)`. null when the minimum is 0.
 */
export function premiumHundredths(bid: bigint, minimum: bigint): bigint | null {
  if (minimum === 0n) return null;
  const diff = bid - minimum;
  const num = diff * 10_000n * 2n;
  const den = minimum * 2n;
  // Half up for either sign: floor((2x + 1) / 2) on the doubled value.
  return diff >= 0n ? (num + minimum) / den : -((-num + minimum) / den);
}

/** Hundredths of a percent as a percent string: 891n → "8.91", 450n → "4.5", 0n → "0". */
export function formatPct(hundredths: bigint): string {
  const sign = hundredths < 0n ? '-' : '';
  const abs = hundredths < 0n ? -hundredths : hundredths;
  const whole = abs / 100n;
  const frac = abs % 100n;
  if (frac === 0n) return `${sign}${whole}`;
  return `${sign}${whole}.${frac.toString().padStart(2, '0').replace(/0$/, '')}`;
}

/** Lamports with a sign: -170_500_000n → "-0.1705". */
export function signedSol(lamports: bigint): string {
  return lamports < 0n ? `-${lamportsToSol(-lamports)}` : lamportsToSol(lamports);
}

/** The median of sorted values; for an even count, the mean of the middle two, rounded half up. */
function median(sorted: bigint[]): bigint {
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] as bigint;
  if (sorted.length % 2 === 1) return hi;
  const lo = sorted[mid - 1] as bigint;
  const sum = lo + hi;
  return sum >= 0n ? (sum + 1n) / 2n : -(-sum / 2n);
}

/** The price signature from the premiums (hundredths), in any order. */
export function priceSignature(premiums: bigint[]): PriceSignature {
  if (premiums.length === 0) {
    return { count: 0, min_pct: null, median_pct: null, max_pct: null, sentence: null };
  }
  const sorted = [...premiums].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lo = sorted[0] as bigint;
  const hi = sorted[sorted.length - 1] as bigint;
  const mid = median(sorted);
  const sentence = sorted.every((p) => p === 0n)
    ? 'Bids the exact minimum.'
    : `Pays about ${formatPct(mid)}% over the minimum (range ${formatPct(lo)}–${formatPct(hi)}%).`;
  return {
    count: sorted.length,
    min_pct: formatPct(lo),
    median_pct: formatPct(mid),
    max_pct: formatPct(hi),
    sentence,
  };
}

/** A duration for a person: "under a minute", "45 min", "2 h 5 min", "3 d 4 h". */
export function formatDuration(seconds: number): string {
  const min = Math.floor(seconds / 60);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

// ---------------------------------------------------------------------------
// Building the report
// ---------------------------------------------------------------------------

/** A wake.log or runner.log line, as far as the report needs it. */
type LogLine = Record<string, unknown>;

export interface ReportInputs {
  folder: string;
  sandbox: boolean;
  activity: ActivityEntry[];
  /** Every wake.log line; filtered here to this kind (live or sandbox). */
  wakeLog: LogLine[];
  /** Every runner.log line; filtered here to this kind, dry runs left out. */
  runnerLog: LogLine[];
  skippedLines?: number;
}

interface Acq {
  entry: ActivityEntry;
  wallet: string;
  bid: bigint;
  matched: boolean;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

function byTime<T extends { ts: string }>(a: T, b: T): number {
  return Date.parse(a.ts) - Date.parse(b.ts);
}

function isAcquisition(entry: ActivityEntry): boolean {
  return (
    entry.event === 'executed' &&
    entry.tool === ACQUIRE_TOOL &&
    entry.bid_sol !== undefined &&
    entry.billboard_before !== undefined &&
    entry.billboard_after !== undefined
  );
}

/** `limit_exceeded: per_bid: <sentence>` → `<sentence>`; anything else as logged. */
function refusalReason(error: string | undefined): string | null {
  if (error === undefined) return null;
  const match = error.match(/^limit_exceeded: [a-z_]+: (.+)$/s);
  return match?.[1] ?? error;
}

export function buildReport(input: ReportInputs): Report {
  const activity = [...input.activity].sort(byTime);

  // Acquisitions: this agent's own executed bids. The wallet is the poster after each.
  const acqs: Acq[] = [];
  const acquisitions: ReportAcquisition[] = [];
  const premiums: bigint[] = [];
  for (const entry of activity) {
    if (!isAcquisition(entry)) continue;
    const bid = solToLamports(entry.bid_sol as string);
    const minimum = minimumBid(solToLamports(entry.billboard_before!.amount_sol));
    const premium = premiumHundredths(bid, minimum);
    if (premium !== null) premiums.push(premium);
    acqs.push({ entry, wallet: entry.billboard_after!.poster, bid, matched: false });
    acquisitions.push({
      ts: entry.ts,
      bid_sol: lamportsToSol(bid),
      minimum_sol: lamportsToSol(minimum),
      premium_pct: premium === null ? null : formatPct(premium),
      tx: entry.tx ?? null,
      proposal_id: entry.proposal_id ?? null,
      reasoning: entry.reasoning ?? null,
    });
  }
  const wallets = new Set(acqs.map((a) => a.wallet));

  // Paid back. The server logs `outbid_detected` only for its own wallet, so
  // every one counts (its poster joins the wallet list); a repeat of the same
  // before/after pair is one outbid.
  const seen = new Set<string>();
  const paidBack: ReportPayback[] = [];
  let paidBackTotal = 0n;
  for (const entry of activity) {
    if (entry.event !== 'outbid_detected') continue;
    const before = entry.billboard_before;
    const after = entry.billboard_after;
    if (before === undefined || after === undefined) continue;
    const key = `${before.poster}:${before.amount_sol}>${after.poster}:${after.amount_sol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    wallets.add(before.poster);
    const stake = solToLamports(before.amount_sol);
    const outbidAt = solToLamports(after.amount_sol);
    let paid: bigint | null = null;
    if (outbidAt >= minimumBid(stake)) {
      paid = splitOnAcquire(stake, outbidAt).prevPosterReceives;
      paidBackTotal += paid;
    }
    // The acquisition this outbid ended: the latest one before it by the same
    // wallet at the same amount, else the latest unmatched one by that wallet.
    const earlier = acqs.filter(
      (a) =>
        !a.matched && a.wallet === before.poster && Date.parse(a.entry.ts) <= Date.parse(entry.ts),
    );
    const acq =
      earlier.filter((a) => a.entry.billboard_after!.amount_sol === before.amount_sol).pop() ??
      earlier.pop() ??
      null;
    if (acq !== null) acq.matched = true;
    paidBack.push({
      ts: entry.ts,
      by: after.poster,
      stake_sol: lamportsToSol(stake),
      outbid_at_sol: lamportsToSol(outbidAt),
      paid_back_sol: paid === null ? null : lamportsToSol(paid),
      gain_sol: paid === null ? null : lamportsToSol(paid - stake),
      acquired_ts: acq?.entry.ts ?? null,
      held_s:
        acq === null
          ? null
          : Math.max(0, Math.round((Date.parse(entry.ts) - Date.parse(acq.entry.ts)) / 1000)),
    });
  }

  // Now: the last acquisition, if no outbid has ended it.
  const last = acqs[acqs.length - 1];
  const onBoard = last !== undefined && !last.matched;
  const now: ReportNow = onBoard
    ? { on_board: true, stake_sol: lamportsToSol(last.bid), since: last.entry.ts }
    : { on_board: false, stake_sol: null, since: null };

  const staked = acqs.reduce((sum, a) => sum + a.bid, 0n);
  const totals: ReportTotals = {
    staked_sol: lamportsToSol(staked),
    paid_back_sol: lamportsToSol(paidBackTotal),
    net_sol: signedSol(paidBackTotal - staked),
    on_board_sol: lamportsToSol(onBoard ? last.bid : 0n),
  };

  // Decisions: this kind's wakes; the gate's holds (dry runs left out: they wake no one).
  const wakes: ReportWake[] = input.wakeLog
    .filter((w) => text(w.ts) !== null && (w.sandbox === true) === input.sandbox)
    .map((w) => ({
      ts: w.ts as string,
      trigger: text(w.trigger) ?? 'unknown',
      decision: text(w.decision) ?? 'missing',
      reason: text(w.reason),
      next_look_hours: typeof w.next_look_hours === 'number' ? w.next_look_hours : null,
      timed_out: w.timed_out === true,
      exit_code: typeof w.exit_code === 'number' ? w.exit_code : null,
    }))
    .sort(byTime);
  const byDecision: Record<string, number> = {};
  for (const w of wakes) byDecision[w.decision] = (byDecision[w.decision] ?? 0) + 1;
  const gateByReason = Object.fromEntries(GATE_EVENTS.map((e) => [e, 0])) as Record<
    GateEvent,
    number
  >;
  for (const line of input.runnerLog) {
    if (line.dry_run === true || (line.sandbox === true) !== input.sandbox) continue;
    const event = line.event as GateEvent;
    if ((GATE_EVENTS as readonly string[]).includes(event)) gateByReason[event] += 1;
  }
  const gateSkips = GATE_EVENTS.reduce((sum, e) => sum + gateByReason[e], 0);

  const refusal = (entry: ActivityEntry, detail: string | null): ReportRefusal => ({
    ts: entry.ts,
    tool: entry.tool,
    bid_sol: entry.bid_sol ?? null,
    proposal_id: entry.proposal_id ?? null,
    detail,
  });
  const refusals = {
    refused_limit: activity
      .filter((e) => e.event === 'refused_limit')
      .map((e) => refusal(e, refusalReason(e.error))),
    expired: activity.filter((e) => e.event === 'expired').map((e) => refusal(e, null)),
    superseded: activity
      .filter((e) => e.event === 'superseded')
      .map((e) => refusal(e, e.superseded_by ?? null)),
  };

  return {
    folder: input.folder,
    sandbox: input.sandbox,
    empty: activity.length === 0 && wakes.length === 0 && gateSkips === 0,
    wallets: [...wallets],
    acquisitions,
    price_signature: priceSignature(premiums),
    paid_back: paidBack,
    now,
    totals,
    decisions: {
      wakes: wakes.length,
      by_decision: byDecision,
      last: wakes.slice(-LAST_DECISIONS),
      gate_skips: gateSkips,
      gate_by_reason: gateByReason,
    },
    refusals,
    other_wakes: input.wakeLog.filter(
      (w) => text(w.ts) !== null && (w.sandbox === true) !== input.sandbox,
    ).length,
    skipped_lines: input.skippedLines ?? 0,
  };
}

// ---------------------------------------------------------------------------
// The text form
// ---------------------------------------------------------------------------

/** Local `YYYY-MM-DD HH:MM` for an ISO time. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function renderReport(
  report: Report,
  formatTime: (iso: string) => string = localTime,
): string {
  if (report.empty) {
    if (report.sandbox || report.other_wakes === 0) return NO_ACTIVITY;
    const n = report.other_wakes;
    return (
      `${NO_ACTIVITY}\nThe sandbox has ${n} ${n === 1 ? 'wake' : 'wakes'}: ` +
      `run '${PACKAGE_NAME} report --sandbox' to see ${n === 1 ? 'it' : 'them'}.`
    );
  }
  const t = formatTime;
  const out: string[] = [];
  const kind = report.sandbox ? 'the sandbox' : 'the live board';
  out.push(`Report for ${report.folder}, on ${kind}, from the agent's own logs.`);
  out.push('It reads no chain data: "now" means as far as the log shows.');
  if (report.wallets.length > 0) out.push(`Wallet: ${report.wallets.join(', ')}`);

  out.push('', `Acquisitions (${report.acquisitions.length})`);
  if (report.acquisitions.length === 0) out.push('  None yet.');
  for (const a of report.acquisitions) {
    const premium = a.premium_pct === null ? 'first post' : `premium ${a.premium_pct}%`;
    out.push(
      `  ${t(a.ts)}  bid ${a.bid_sol} SOL, minimum ${a.minimum_sol} SOL, ${premium}` +
        (a.tx === null ? '' : `, tx ${a.tx}`),
    );
  }

  const sig = report.price_signature;
  out.push('', 'Price signature');
  if (sig.count === 0) {
    out.push('  No bid over a minimum yet.');
  } else {
    out.push(
      `  ${sig.count} ${sig.count === 1 ? 'bid' : 'bids'}; premium over the minimum: ` +
        `min ${sig.min_pct}%, median ${sig.median_pct}%, max ${sig.max_pct}%.`,
      `  ${sig.sentence}`,
    );
  }

  out.push('', `Paid back (${report.paid_back.length})`);
  if (report.paid_back.length === 0) out.push('  Not outbid yet.');
  for (const p of report.paid_back) {
    const paid =
      p.paid_back_sol === null
        ? 'the logged amounts are not a valid outbid, so the payback is unknown'
        : `stake ${p.stake_sol} SOL + ${p.gain_sol} SOL = ${p.paid_back_sol} SOL paid back`;
    const held =
      p.held_s === null
        ? ''
        : `; the message held ${formatDuration(p.held_s)} (until the outbid was noticed)`;
    out.push(`  ${t(p.ts)}  outbid at ${p.outbid_at_sol} SOL: ${paid}${held}.`);
  }

  out.push('', 'Now');
  out.push(
    report.now.on_board
      ? `  A stake of ${report.now.stake_sol} SOL is on the board, posted ${t(report.now.since as string)}.`
      : '  No stake on the board.',
  );

  const tot = report.totals;
  out.push('', 'Totals');
  out.push(
    `  Staked ${tot.staked_sol} SOL, paid back ${tot.paid_back_sol} SOL, net ${tot.net_sol} SOL.`,
  );
  if (report.now.on_board) {
    out.push(
      `  ${tot.on_board_sol} SOL of the stake is on the board now; it comes back, with half the increase, only if someone outbids it.`,
    );
  }

  const d = report.decisions;
  out.push('', `Decisions (${d.wakes} ${d.wakes === 1 ? 'wake' : 'wakes'})`);
  if (d.wakes > 0) {
    out.push(
      `  ${Object.entries(d.by_decision)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')}`,
    );
    if (d.wakes > d.last.length) out.push(`  The last ${d.last.length}:`);
    for (const w of d.last) {
      const notes = [
        w.timed_out ? 'timed out' : null,
        w.exit_code !== null && w.exit_code !== 0 ? `exit ${w.exit_code}` : null,
        w.next_look_hours === null ? null : `next look ${w.next_look_hours} h`,
      ].filter((n) => n !== null);
      out.push(
        `  ${t(w.ts)}  ${w.trigger}: ${w.decision}${w.reason === null ? '' : ` - ${oneLine(w.reason)}`}` +
          (notes.length > 0 ? ` (${notes.join(', ')})` : ''),
      );
    }
  }
  if (d.gate_skips > 0) {
    const reasons = GATE_EVENTS.filter((e) => d.gate_by_reason[e] > 0)
      .map((e) => `${GATE_LABEL[e]} ${d.gate_by_reason[e]}`)
      .join(', ');
    out.push(
      `  The affordability gate held a wake back ${d.gate_skips} ${d.gate_skips === 1 ? 'time' : 'times'} ` +
        `without a model call (${reasons}; each logged once per board state).`,
    );
  } else if (d.wakes === 0) {
    out.push('  No wakes yet.');
  }

  const r = report.refusals;
  out.push('', 'Refusals');
  if (r.refused_limit.length + r.expired.length + r.superseded.length === 0) out.push('  None.');
  const bid = (x: ReportRefusal): string =>
    x.bid_sol === null ? '' : ` a bid of ${x.bid_sol} SOL`;
  for (const x of r.refused_limit) {
    out.push(
      `  ${t(x.ts)}  refused by your limits:${bid(x)}${x.detail === null ? '' : ` (${oneLine(x.detail)})`}`,
    );
  }
  for (const x of r.expired) {
    out.push(
      `  ${t(x.ts)}  proposal ${x.proposal_id ?? '?'} expired unapproved:${bid(x) || ` ${x.tool}`}`,
    );
  }
  for (const x of r.superseded) {
    out.push(
      `  ${t(x.ts)}  proposal ${x.proposal_id ?? '?'} superseded by ${x.detail ?? 'a newer one'}:${bid(x) || ` ${x.tool}`}`,
    );
  }

  if (report.skipped_lines > 0) {
    out.push(
      '',
      `${report.skipped_lines} unreadable log ${report.skipped_lines === 1 ? 'line was' : 'lines were'} left out.`,
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface ReportIo {
  write: (text: string) => void;
  writeErr: (text: string) => void;
}

export interface ReportDeps {
  io?: Partial<ReportIo>;
  /** Directory `dir` resolves against. Default `process.cwd()`. */
  cwd?: string;
  /** How times print in the text form. Default local `YYYY-MM-DD HH:MM`. */
  formatTime?: (iso: string) => string;
}

/** Reads a JSON-lines file tolerantly: a missing file is empty, a bad line is counted. */
export function readJsonLines(path: string): { lines: LogLine[]; skipped: number } {
  if (!existsSync(path)) return { lines: [], skipped: 0 };
  const lines: LogLine[] = [];
  let skipped = 0;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        lines.push(value as LogLine);
        continue;
      }
    } catch {
      // counted below
    }
    skipped++;
  }
  return { lines, skipped };
}

/** The live activity log: `.env`'s ACTIVITY_LOG_PATH when set (as the server and runner use it), else the default. */
function activityLogPath(paths: AgentPaths, sandbox: boolean): string {
  if (sandbox) return paths.sandboxActivityLog;
  let configured: string | undefined;
  try {
    configured = readEnvFile(paths.env).ACTIVITY_LOG_PATH?.trim();
  } catch {
    configured = undefined;
  }
  return resolve(paths.dir, configured || DEFAULT_ACTIVITY_LOG_PATH);
}

/** Loads the logs in the folder at `args.dir` and builds the report. */
export function loadReport(args: ReportArgs, cwd: string = process.cwd()): Report {
  const paths = agentPaths(args.dir, cwd);
  if (!existsSync(paths.dir) || !statSync(paths.dir).isDirectory()) {
    throw new ReportError(`there is no folder at ${paths.dir}.`);
  }
  let skipped = 0;
  const log = new ActivityLog(activityLogPath(paths, args.sandbox), { warn: () => {} });
  const { entries, skipped: activitySkipped } = log.read();
  skipped += activitySkipped;
  const wakeLog = readJsonLines(paths.wakeLog);
  const runnerLog = readJsonLines(paths.runnerLog);
  skipped += wakeLog.skipped + runnerLog.skipped;
  return buildReport({
    folder: paths.dir,
    sandbox: args.sandbox,
    activity: entries,
    wakeLog: wakeLog.lines,
    runnerLog: runnerLog.lines,
    skippedLines: skipped,
  });
}

/** `report [dir]`. Exit 0 with a report (or `No activity yet.`), 2 when there is no folder or a log cannot be read. */
export async function runReport(args: ReportArgs, deps: ReportDeps = {}): Promise<number> {
  const write = deps.io?.write ?? ((s: string) => void process.stdout.write(s));
  const writeErr = deps.io?.writeErr ?? ((s: string) => void process.stderr.write(s));
  let report: Report;
  try {
    report = loadReport(args, deps.cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`${PACKAGE_NAME}: report: ${message}\n`);
    writeErr(`Run '${PACKAGE_NAME} report --help' for usage.\n`);
    return 2;
  }
  write(
    args.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${renderReport(report, deps.formatTime)}\n`,
  );
  return 0;
}
