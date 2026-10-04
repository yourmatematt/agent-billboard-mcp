/**
 * src/agent/report.ts: the agent's record from fixture logs in a temp folder.
 * Offline: no RPC, no model, no keypair read. Every premium and payback
 * figure asserted here is worked by hand in the comments beside it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReportArgs } from '../../src/cli.js';
import { agentPaths, type AgentPaths } from '../../src/agent/folder.js';
import {
  LAST_DECISIONS,
  NO_ACTIVITY,
  buildReport,
  formatDuration,
  formatPct,
  loadReport,
  premiumHundredths,
  priceSignature,
  runReport,
  signedSol,
  type Report,
} from '../../src/agent/report.js';
import { ActivityLog, type ActivityEntryInput } from '../../src/log/activity.js';
import { splitOnAcquire } from '../../src/program/math.js';

// Plain labels for posters: the report only compares them as strings.
const AGENT = 'AgentWa11et1111111111111111111111111111111';
const FIRST = 'F1rstPoster111111111111111111111111111111';
const RIVAL = 'Riva1Poster111111111111111111111111111111';
const LATER = 'LaterPoster111111111111111111111111111111';
const SECRET_TEXT = '[1,2,3,4,5,6,7,8,9,10,"never-printed"]';

const at = (hhmm: string): string => `2026-10-04T${hhmm}:00.000Z`;
/** Deterministic times for the text form: `2026-10-04 01:00Z`. */
const utc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;

let root: string;
let paths: AgentPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abm-report-'));
  paths = agentPaths('agent', root);
  mkdirSync(paths.logs, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const args = (over: Partial<ReportArgs> = {}): ReportArgs => ({
  dir: 'agent',
  sandbox: false,
  json: false,
  ...over,
});

function writeActivity(path: string, entries: ActivityEntryInput[]): void {
  const log = new ActivityLog(path);
  for (const entry of entries) log.append(entry);
}

function writeLines(path: string, lines: (object | string)[]): void {
  writeFileSync(
    path,
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
  );
}

function wake(over: Record<string, unknown>): Record<string, unknown> {
  return {
    trigger: 'board_changed',
    sandbox: false,
    exit_code: 0,
    timed_out: false,
    duration_s: 40,
    decision: 'passed',
    reason: null,
    next_look_hours: 6,
    next_look_reason: 'quiet board',
    transcript: 'logs/wakes/x.jsonl',
    ...over,
  };
}

/**
 * The fixture: two acquisitions at different premiums, one outbid with
 * payback (logged twice, counted once), one current stake, one
 * refused_limit, an expired and a superseded proposal, an append chunk and
 * an append_message that are not acquisitions, a wake.log (live, sandbox and
 * one unreadable line) and a runner.log with gate skips (and a dry-run one
 * that is left out).
 */
function writeFixture(): void {
  writeActivity(paths.activityLog, [
    {
      ts: at('01:00'),
      event: 'executed',
      tool: 'acquire_posting_rights',
      reasoning: 'The board is cheap and my belief is worth the minimum.',
      bid_sol: '0.101',
      tx: 'sigA1',
      billboard_before: { poster: FIRST, amount_sol: '0.1' },
      billboard_after: { poster: AGENT, amount_sol: '0.101' },
    },
    // The second transaction of the same post: no bid, so not an acquisition.
    { ts: at('01:01'), event: 'executed', tool: 'acquire_posting_rights', tx: 'sigA1b' },
    { ts: at('02:00'), event: 'executed', tool: 'append_message', tx: 'sigAppend' },
    {
      ts: at('03:00'),
      event: 'outbid_detected',
      tool: 'billboard_reader',
      billboard_before: { poster: AGENT, amount_sol: '0.101' },
      billboard_after: { poster: RIVAL, amount_sol: '0.2' },
    },
    // The same outbid seen again by another server process: counted once.
    {
      ts: at('03:05'),
      event: 'outbid_detected',
      tool: 'billboard_reader',
      billboard_before: { poster: AGENT, amount_sol: '0.101' },
      billboard_after: { poster: RIVAL, amount_sol: '0.2' },
    },
    {
      ts: at('04:00'),
      event: 'refused_limit',
      tool: 'acquire_posting_rights',
      reasoning: 'Worth a premium.',
      bid_sol: '0.25',
      error: 'limit_exceeded: per_bid: bid 0.25 SOL is above MAX_BID_SOL 0.22 SOL',
      billboard_before: { poster: RIVAL, amount_sol: '0.2' },
    },
    {
      ts: at('05:00'),
      event: 'executed',
      tool: 'acquire_posting_rights',
      reasoning: 'Worth a visible premium today.',
      proposal_id: 'prop_a2',
      bid_sol: '0.22',
      tx: 'sigA2',
      billboard_before: { poster: RIVAL, amount_sol: '0.2' },
      billboard_after: { poster: AGENT, amount_sol: '0.22' },
    },
    {
      ts: at('06:00'),
      event: 'expired',
      tool: 'acquire_posting_rights',
      proposal_id: 'prop_x1',
      bid_sol: '0.3',
      billboard_before: { poster: AGENT, amount_sol: '0.22' },
    },
    {
      ts: at('06:10'),
      event: 'superseded',
      tool: 'acquire_posting_rights',
      proposal_id: 'prop_x2',
      superseded_by: 'prop_x3',
      bid_sol: '0.24',
      billboard_before: { poster: AGENT, amount_sol: '0.22' },
    },
  ]);
  writeLines(paths.wakeLog, [
    wake({
      ts: at('00:58'),
      trigger: 'first',
      decision: 'acquired',
      reason: 'Bid the minimum; the belief fits.',
    }),
    wake({
      ts: at('03:30'),
      decision: 'passed',
      reason: 'Over my per-bid limit.',
      next_look_hours: 12,
    }),
    'not json at all',
    wake({
      ts: at('04:58'),
      trigger: 'self_chosen',
      decision: 'acquired',
      reason: 'Paid a premium.',
    }),
    wake({
      ts: at('07:00'),
      decision: 'missing',
      timed_out: true,
      exit_code: null,
      next_look_hours: null,
    }),
    wake({
      ts: at('08:00'),
      trigger: 'manual',
      sandbox: true,
      decision: 'acquired',
      reason: 'Rehearsal.',
    }),
  ]);
  writeLines(paths.runnerLog, [
    { ts: at('00:50'), event: 'started' },
    { ts: at('02:10'), event: 'skipped_poster', poster: AGENT },
    { ts: at('02:40'), event: 'skipped_poster', poster: AGENT },
    { ts: at('03:20'), event: 'priced_out', minimum_sol: '0.202', message: 'Priced out: ...' },
    { ts: at('03:25'), event: 'waiting_for_budget', until: at('23:00') },
    { ts: at('03:26'), event: 'unfunded', shortfall_sol: '0.01' },
    { ts: at('03:27'), event: 'priced_out', dry_run: true },
    { ts: at('04:58'), event: 'wake_started', trigger: 'self_chosen' },
  ]);
  // A keypair in the folder: the report never reads or prints it.
  writeFileSync(paths.keypair, SECRET_TEXT);
}

function capture(): {
  out: string[];
  err: string[];
  io: { write: (s: string) => void; writeErr: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { write: (s) => void out.push(s), writeErr: (s) => void err.push(s) } };
}

describe('report arithmetic', () => {
  it('premium in hundredths of a percent, rounded half up', () => {
    // 0.101 over a minimum of 0.101 → 0.
    expect(premiumHundredths(101_000_000n, 101_000_000n)).toBe(0n);
    // 0.22 over 0.202: 18_000_000 * 10_000 / 202_000_000 = 891.089… → 891 (8.91%).
    expect(premiumHundredths(220_000_000n, 202_000_000n)).toBe(891n);
    // 3 over 200: 3 * 10_000 / 200 = 150 exactly (1.5%).
    expect(premiumHundredths(203n, 200n)).toBe(150n);
    // 1 over 8: 10_000 / 8 = 1250 (12.5%); 1 over 3: 3333.33… → 3333; 2 over 3: 6666.67… → 6667.
    expect(premiumHundredths(9n, 8n)).toBe(1250n);
    expect(premiumHundredths(4n, 3n)).toBe(3333n);
    expect(premiumHundredths(5n, 3n)).toBe(6667n);
    // Half up: 1 over 80_000 = 0.125 hundredths → 0; 1 over 20_000 = 0.5 → 1.
    expect(premiumHundredths(80_001n, 80_000n)).toBe(0n);
    expect(premiumHundredths(20_001n, 20_000n)).toBe(1n);
    // Over an empty board the minimum is 0: no premium.
    expect(premiumHundredths(50_000_000n, 0n)).toBeNull();
    // A logged bid below the minimum (never on chain) still reports a sign.
    expect(premiumHundredths(199n, 200n)).toBe(-50n);
  });

  it('formats percentages and signed SOL', () => {
    expect(formatPct(0n)).toBe('0');
    expect(formatPct(891n)).toBe('8.91');
    expect(formatPct(450n)).toBe('4.5');
    expect(formatPct(805n)).toBe('8.05');
    expect(formatPct(10n)).toBe('0.1');
    expect(formatPct(10_000n)).toBe('100');
    expect(formatPct(-50n)).toBe('-0.5');
    expect(signedSol(-170_500_000n)).toBe('-0.1705');
    expect(signedSol(0n)).toBe('0');
    expect(signedSol(1_000_000_000n)).toBe('1');
  });

  it('price signature: exact minimum, median of an odd and an even count', () => {
    expect(priceSignature([]).sentence).toBeNull();
    expect(priceSignature([0n, 0n, 0n])).toEqual({
      count: 3,
      min_pct: '0',
      median_pct: '0',
      max_pct: '0',
      sentence: 'Bids the exact minimum.',
    });
    // Sorted 0, 100, 1000: median 100 (1%).
    expect(priceSignature([1000n, 0n, 100n]).sentence).toBe(
      'Pays about 1% over the minimum (range 0–10%).',
    );
    // Even count: (0 + 891 + 1) / 2 = 446 → 4.46%.
    expect(priceSignature([891n, 0n]).median_pct).toBe('4.46');
  });

  it('payback is the stake plus half the increase, the odd lamport to the poster', () => {
    // Stake 101, outbid at 105: increase 4, creator floor(4 / 2) = 2, paid back 103 = 101 + 2.
    expect(splitOnAcquire(101n, 105n).prevPosterReceives).toBe(103n);
    // Outbid at 106: increase 5, creator floor(2.5) = 2, paid back 104 = 101 + 3.
    expect(splitOnAcquire(101n, 106n).prevPosterReceives).toBe(104n);
  });

  it('durations read like a person wrote them', () => {
    expect(formatDuration(59)).toBe('under a minute');
    expect(formatDuration(45 * 60)).toBe('45 min');
    expect(formatDuration(7200)).toBe('2 h 0 min');
    expect(formatDuration(2 * 3600 + 5 * 60 + 59)).toBe('2 h 5 min');
    expect(formatDuration(76 * 3600)).toBe('3 d 4 h');
  });
});

describe('report from the fixture logs', () => {
  let report: Report;
  beforeEach(() => {
    writeFixture();
    report = loadReport(args(), root);
  });

  it('lists the two acquisitions with the minimum at that moment and the premium', () => {
    expect(report.empty).toBe(false);
    expect(report.wallets).toEqual([AGENT]);
    expect(report.acquisitions).toEqual([
      {
        ts: at('01:00'),
        bid_sol: '0.101',
        // minimumBid(0.1 SOL) = floor(100_000_000 * 10_100 / 10_000) = 101_000_000 = 0.101; premium 0.
        minimum_sol: '0.101',
        premium_pct: '0',
        tx: 'sigA1',
        proposal_id: null,
        reasoning: 'The board is cheap and my belief is worth the minimum.',
      },
      {
        ts: at('05:00'),
        bid_sol: '0.22',
        // minimumBid(0.2) = 202_000_000; (220_000_000 - 202_000_000) / 202_000_000 = 8.9108…% → 8.91.
        minimum_sol: '0.202',
        premium_pct: '8.91',
        tx: 'sigA2',
        proposal_id: 'prop_a2',
        reasoning: 'Worth a visible premium today.',
      },
    ]);
  });

  it('price signature over the two premiums', () => {
    // Premiums 0 and 891 hundredths: median (0 + 891 + 1) / 2 = 446 → 4.46%.
    expect(report.price_signature).toEqual({
      count: 2,
      min_pct: '0',
      median_pct: '4.46',
      max_pct: '8.91',
      sentence: 'Pays about 4.46% over the minimum (range 0–8.91%).',
    });
  });

  it('paid back once for the outbid, with how long the message held', () => {
    // Stake 0.101, outbid at 0.2: increase 99_000_000; creator floor(99_000_000 * 5_000 / 10_000)
    // = 49_500_000; paid back 200_000_000 - 49_500_000 = 150_500_000 = 0.101 + 0.0495 = 0.1505.
    // Held from the 01:00 acquisition to the 03:00 outbid: 7200 s.
    expect(report.paid_back).toEqual([
      {
        ts: at('03:00'),
        by: RIVAL,
        stake_sol: '0.101',
        outbid_at_sol: '0.2',
        paid_back_sol: '0.1505',
        gain_sol: '0.0495',
        acquired_ts: at('01:00'),
        held_s: 7200,
      },
    ]);
  });

  it('the current stake, totals, decisions, gate skips and refusals', () => {
    expect(report.now).toEqual({ on_board: true, stake_sol: '0.22', since: at('05:00') });
    // Staked 0.101 + 0.22 = 0.321; paid back 0.1505; net 0.1505 - 0.321 = -0.1705.
    expect(report.totals).toEqual({
      staked_sol: '0.321',
      paid_back_sol: '0.1505',
      net_sol: '-0.1705',
      on_board_sol: '0.22',
    });
    // Live wakes only (the sandbox one is left out), oldest first.
    expect(report.decisions.wakes).toBe(4);
    expect(report.decisions.by_decision).toEqual({ acquired: 2, passed: 1, missing: 1 });
    expect(report.decisions.last.map((w) => w.ts)).toEqual([
      at('00:58'),
      at('03:30'),
      at('04:58'),
      at('07:00'),
    ]);
    expect(report.decisions.last[3]).toMatchObject({ timed_out: true, exit_code: null });
    // Two poster holds, one each of the others; the dry-run priced_out is left out.
    expect(report.decisions.gate_skips).toBe(5);
    expect(report.decisions.gate_by_reason).toEqual({
      priced_out: 1,
      waiting_for_budget: 1,
      unfunded: 1,
      skipped_poster: 2,
    });
    expect(report.refusals.refused_limit).toEqual([
      {
        ts: at('04:00'),
        tool: 'acquire_posting_rights',
        bid_sol: '0.25',
        proposal_id: null,
        detail: 'bid 0.25 SOL is above MAX_BID_SOL 0.22 SOL',
      },
    ]);
    expect(report.refusals.expired).toEqual([
      {
        ts: at('06:00'),
        tool: 'acquire_posting_rights',
        bid_sol: '0.3',
        proposal_id: 'prop_x1',
        detail: null,
      },
    ]);
    expect(report.refusals.superseded[0]).toMatchObject({
      proposal_id: 'prop_x2',
      detail: 'prop_x3',
    });
    // The one unreadable wake.log line.
    expect(report.skipped_lines).toBe(1);
  });

  it('prints the text form', async () => {
    const c = capture();
    expect(await runReport(args(), { cwd: root, io: c.io, formatTime: utc })).toBe(0);
    expect(c.err).toEqual([]);
    const out = c.out.join('');
    expect(out).toContain(`Report for ${paths.dir}, on the live board, from the agent's own logs.`);
    expect(out).toContain(`Wallet: ${AGENT}`);
    expect(out).toContain('Acquisitions (2)');
    expect(out).toContain(
      '  2026-10-04 01:00Z  bid 0.101 SOL, minimum 0.101 SOL, premium 0%, tx sigA1',
    );
    expect(out).toContain(
      '  2026-10-04 05:00Z  bid 0.22 SOL, minimum 0.202 SOL, premium 8.91%, tx sigA2',
    );
    expect(out).toContain('  2 bids; premium over the minimum: min 0%, median 4.46%, max 8.91%.');
    expect(out).toContain('  Pays about 4.46% over the minimum (range 0–8.91%).');
    expect(out).toContain(
      '  2026-10-04 03:00Z  outbid at 0.2 SOL: stake 0.101 SOL + 0.0495 SOL = 0.1505 SOL paid back; ' +
        'the message held 2 h 0 min (until the outbid was noticed).',
    );
    expect(out).toContain('  A stake of 0.22 SOL is on the board, posted 2026-10-04 05:00Z.');
    expect(out).toContain('  Staked 0.321 SOL, paid back 0.1505 SOL, net -0.1705 SOL.');
    expect(out).toContain('Decisions (4 wakes)');
    expect(out).toContain('  acquired 2, missing 1, passed 1');
    expect(out).toContain(
      '  2026-10-04 03:30Z  board_changed: passed - Over my per-bid limit. (next look 12 h)',
    );
    expect(out).toContain('  2026-10-04 07:00Z  board_changed: missing (timed out)');
    expect(out).toContain(
      '  The affordability gate held a wake back 5 times without a model call ' +
        '(priced out 1, waiting for budget 1, unfunded 1, already the poster 2; each logged once per board state).',
    );
    expect(out).toContain(
      '  2026-10-04 04:00Z  refused by your limits: a bid of 0.25 SOL (bid 0.25 SOL is above MAX_BID_SOL 0.22 SOL)',
    );
    expect(out).toContain(
      '  2026-10-04 06:00Z  proposal prop_x1 expired unapproved: a bid of 0.3 SOL',
    );
    expect(out).toContain(
      '  2026-10-04 06:10Z  proposal prop_x2 superseded by prop_x3: a bid of 0.24 SOL',
    );
    expect(out).toContain('1 unreadable log line was left out.');
    expect(out).not.toContain('Rehearsal.');
    expect(out).not.toContain('never-printed');
    // Andy's words only.
    expect(out).not.toMatch(/\b(slot|took|grabbed|won|owns)\b/i);
  });

  it('prints the same as one JSON object with --json', async () => {
    const c = capture();
    expect(await runReport(args({ json: true }), { cwd: root, io: c.io })).toBe(0);
    const parsed = JSON.parse(c.out.join('')) as Report;
    expect(parsed).toEqual(JSON.parse(JSON.stringify(report)));
    expect(c.out.join('')).not.toContain('never-printed');
  });
});

describe('report edge cases', () => {
  it('an empty folder prints No activity yet. and exits 0', async () => {
    const c = capture();
    expect(await runReport(args(), { cwd: root, io: c.io })).toBe(0);
    expect(c.out.join('')).toBe(`${NO_ACTIVITY}\n`);
    const j = capture();
    expect(await runReport(args({ json: true }), { cwd: root, io: j.io })).toBe(0);
    expect(JSON.parse(j.out.join(''))).toMatchObject({
      empty: true,
      acquisitions: [],
      totals: { staked_sol: '0', paid_back_sol: '0', net_sol: '0', on_board_sol: '0' },
    });
  });

  it('a runner.log with only gate holds is a report, not "no activity"', async () => {
    writeLines(paths.runnerLog, [{ ts: at('01:00'), event: 'priced_out', message: 'x' }]);
    const c = capture();
    expect(await runReport(args(), { cwd: root, io: c.io, formatTime: utc })).toBe(0);
    const out = c.out.join('');
    expect(out).toContain('  None yet.');
    expect(out).toContain('  No bid over a minimum yet.');
    expect(out).toContain('  Not outbid yet.');
    expect(out).toContain('  No stake on the board.');
    expect(out).toContain('held a wake back 1 time without a model call (priced out 1;');
  });

  it('a live report with only sandbox wakes says so and points at --sandbox', async () => {
    writeLines(paths.wakeLog, [
      wake({ ts: at('08:00'), trigger: 'manual', sandbox: true, decision: 'acquired' }),
    ]);
    const c = capture();
    expect(await runReport(args(), { cwd: root, io: c.io })).toBe(0);
    expect(c.out.join('')).toBe(
      `${NO_ACTIVITY}\nThe sandbox has 1 wake: run 'agent-billboard-mcp report --sandbox' to see it.\n`,
    );
    const s = capture();
    expect(await runReport(args({ sandbox: true }), { cwd: root, io: s.io })).toBe(0);
    expect(s.out.join('')).toContain('Decisions (1 wake)');
    expect(s.out.join('')).toContain('manual: acquired');
  });

  it('a missing folder exits 2 with one sentence', async () => {
    const c = capture();
    expect(await runReport(args({ dir: 'nope' }), { cwd: root, io: c.io })).toBe(2);
    expect(c.out).toEqual([]);
    expect(c.err.join('')).toContain(`report: there is no folder at ${join(root, 'nope')}.`);
  });

  it('--sandbox reads the sandbox log and the sandbox wakes only', async () => {
    writeFixture();
    writeActivity(paths.sandboxActivityLog, [
      {
        ts: at('08:01'),
        event: 'executed',
        tool: 'acquire_posting_rights',
        bid_sol: '0.101',
        tx: 'sandboxSig',
        billboard_before: { poster: FIRST, amount_sol: '0.1' },
        billboard_after: { poster: LATER, amount_sol: '0.101' },
      },
    ]);
    const report = loadReport(args({ sandbox: true }), root);
    expect(report.wallets).toEqual([LATER]);
    expect(report.acquisitions.map((a) => a.tx)).toEqual(['sandboxSig']);
    expect(report.price_signature.sentence).toBe('Bids the exact minimum.');
    expect(report.decisions.wakes).toBe(1);
    expect(report.decisions.last[0]).toMatchObject({ trigger: 'manual', reason: 'Rehearsal.' });
    // The sandbox has no gate.
    expect(report.decisions.gate_skips).toBe(0);
    const c = capture();
    await runReport(args({ sandbox: true }), { cwd: root, io: c.io });
    expect(c.out.join('')).toContain('on the sandbox, from');
  });

  it("honours ACTIVITY_LOG_PATH in the folder's .env, as the server does", () => {
    writeFileSync(paths.env, 'MAX_BID_SOL=0.2\nACTIVITY_LOG_PATH=./elsewhere.jsonl\n');
    writeActivity(join(paths.dir, 'elsewhere.jsonl'), [
      {
        ts: at('01:00'),
        event: 'refused_limit',
        tool: 'acquire_posting_rights',
        bid_sol: '0.3',
        error: 'limit_exceeded: daily_cap: over the cap',
      },
    ]);
    const report = loadReport(args(), root);
    expect(report.refusals.refused_limit[0]?.detail).toBe('over the cap');
  });

  it('a first post over an empty board has no premium and counts as a stake', () => {
    const report = buildReport({
      folder: 'x',
      sandbox: false,
      activity: [
        {
          ts: at('01:00'),
          event: 'executed',
          tool: 'acquire_posting_rights',
          bid_sol: '0.05',
          billboard_before: { poster: FIRST, amount_sol: '0' },
          billboard_after: { poster: AGENT, amount_sol: '0.05' },
        },
      ],
      wakeLog: [],
      runnerLog: [],
    });
    expect(report.acquisitions[0]).toMatchObject({ minimum_sol: '0', premium_pct: null });
    expect(report.price_signature.count).toBe(0);
    expect(report.now).toMatchObject({ on_board: true, stake_sol: '0.05' });
  });

  it('an outbid logged across two flips has no valid split: payback unknown, not invented', () => {
    const report = buildReport({
      folder: 'x',
      sandbox: false,
      activity: [
        {
          ts: at('01:00'),
          event: 'executed',
          tool: 'acquire_posting_rights',
          bid_sol: '0.2',
          billboard_before: { poster: FIRST, amount_sol: '0.1' },
          billboard_after: { poster: AGENT, amount_sol: '0.2' },
        },
        {
          // 0.2001 is below minimumBid(0.2) = 0.202: not a single outbid.
          ts: at('02:00'),
          event: 'outbid_detected',
          tool: 'billboard_reader',
          billboard_before: { poster: AGENT, amount_sol: '0.2' },
          billboard_after: { poster: RIVAL, amount_sol: '0.2001' },
        },
      ],
      wakeLog: [],
      runnerLog: [],
    });
    expect(report.paid_back[0]).toMatchObject({ paid_back_sol: null, held_s: 3600 });
    expect(report.totals).toMatchObject({ paid_back_sol: '0', net_sol: '-0.2', on_board_sol: '0' });
    expect(report.now.on_board).toBe(false);
  });

  it(`lists only the last ${LAST_DECISIONS} decisions, oldest first`, () => {
    const lines = Array.from({ length: 12 }, (_, i) =>
      wake({ ts: at(`${String(i + 10).padStart(2, '0')}:00`), reason: `wake ${i + 1}` }),
    );
    const report = buildReport({
      folder: 'x',
      sandbox: false,
      activity: [],
      wakeLog: lines,
      runnerLog: [],
    });
    expect(report.decisions.wakes).toBe(12);
    expect(report.decisions.last.map((w) => w.reason)).toEqual(
      Array.from({ length: 10 }, (_, i) => `wake ${i + 3}`),
    );
    expect(report.decisions.by_decision).toEqual({ passed: 12 });
  });
});
