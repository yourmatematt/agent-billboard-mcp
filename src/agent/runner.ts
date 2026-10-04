/**
 * When `run` wakes the agent. Never what the agent does: that is the model's
 * job, through the billboard tools, inside the operator's limits.
 *
 * Ported from the house fleet's `bin/runner.mjs` (same triggers, same rails,
 * same fake-clock structure), plus the affordability gate that round two
 * showed was missing.
 *
 * Triggers (why a wake is due):
 *   first          the first look, a random 0..first_wake_max_min after start
 *   board_changed  the board changed and the new poster is not this wallet;
 *                  the wake is a random react_min_min..react_max_min later
 *   self_chosen    the NEXT_LOOK the agent gave at its last wake, clamped to
 *                  next_look_min_h..next_look_max_h (missing or invalid: a
 *                  random 3..12 h)
 *   manual         a one-off wake the operator started (`--once`, `--sandbox`)
 *
 * The affordability gate (before every wake, no model call, skipped in the
 * sandbox): no wake when this wallet is already the poster; when the minimum
 * bid is above MAX_BID_SOL (priced out: the price only goes up); when it is
 * above what is left of DAILY_CAP_SOL in the rolling 24 h (wait until the
 * exact moment enough of the oldest spend leaves the window); or when the
 * wallet holds less than the minimum plus 0.01 SOL. `.env` is re-read every
 * time, so raising a limit takes effect without a restart.
 *
 * Rails (after the gate): at least min_gap_min between wakes, fewer than
 * max_wakes_24h in any rolling 24 h, and a PAUSE file in the folder stops
 * wakes until it is removed. RPC errors back off 30 s doubling to 10 min. The
 * loop never sleeps longer than 60 s, so PAUSE, clock jumps and sleep/resume
 * are noticed.
 *
 * State is `runner-state.json` in the folder (a dry run and a sandbox run keep
 * theirs under `logs/`, so they never touch the live one), written atomically.
 * Events go to `logs/runner.log`, one JSON object per line. Nothing here
 * reads the keypair: the wallet arrives as a public key.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

import { DEFAULT_ACTIVITY_LOG_PATH } from '../config.js';
import { ActivityLog } from '../log/activity.js';
import { BILLBOARD_ADDRESS, decodeBillboard } from '../program/layout.js';
import { lamportsToSol, minimumBid, solToLamports } from '../program/math.js';
import { SpendLimits, WINDOW_MS } from '../spend/limits.js';
import { readEnvFile, writeFileAtomic, type AgentPaths, type AgentSettings } from './folder.js';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

export const BACKOFF_START_MS = 30_000;
export const BACKOFF_MAX_MS = 10 * MIN_MS;
/** When a wake gives no usable NEXT_LOOK: a uniform random 3..12 h. */
export const DEFAULT_LOOK_MIN_H = 3;
export const DEFAULT_LOOK_MAX_H = 12;
/** A wake that never started (claude could not be launched) is retried after this. */
export const RETRY_AFTER_SKIP_MS = 10 * MIN_MS;
/** The loop never sleeps longer than this. */
export const MAX_SLEEP_MS = MIN_MS;
/** Wakes older than this are dropped from state (the rails only look back 24 h). */
const WAKES_KEPT_MS = 2 * DAY_MS;
/** The wallet balance is read at most this often. */
export const BALANCE_CACHE_MS = 5 * MIN_MS;
/** What the wallet must hold beyond the minimum bid: fees and rent headroom. */
export const FEE_HEADROOM_LAMPORTS = 10_000_000n;

export type Trigger = 'first' | 'board_changed' | 'self_chosen' | 'manual';

// ---------------------------------------------------------------------------
// The narrow RPC the runner needs (both SolanaRpc and MockRpc satisfy it)
// ---------------------------------------------------------------------------

export interface RunnerRpc {
  getAccount(pubkey: PublicKey): Promise<Buffer | null>;
  getBalance(pubkey: PublicKey): Promise<bigint>;
}

// ---------------------------------------------------------------------------
// Timing rules
// ---------------------------------------------------------------------------

const uniform = (random: () => number, lo: number, hi: number): number => lo + (hi - lo) * random();

export interface NextLook {
  ms: number;
  /** The hours used after clamping, or null when defaulted. */
  hours: number | null;
  defaulted: boolean;
}

/**
 * When the agent looks again after a wake. A whole number of hours is clamped
 * to minH..maxH and given ±10% jitter; anything else (missing, fractional, a
 * string) becomes a uniform random 3..12 h.
 */
export function nextLookDelay(
  hours: unknown,
  {
    minH = 1,
    maxH = 24,
    random = Math.random,
  }: { minH?: number; maxH?: number; random?: () => number } = {},
): NextLook {
  if (typeof hours === 'number' && Number.isInteger(hours)) {
    const clamped = Math.min(maxH, Math.max(minH, hours));
    return {
      ms: Math.round(clamped * HOUR_MS * uniform(random, 0.9, 1.1)),
      hours: clamped,
      defaulted: false,
    };
  }
  return {
    ms: Math.round(uniform(random, DEFAULT_LOOK_MIN_H, DEFAULT_LOOK_MAX_H) * HOUR_MS),
    hours: null,
    defaulted: true,
  };
}

export type RailReason = 'min_gap' | 'max_wakes_24h';

/**
 * The earliest moment the rails allow another wake: min_gap after the last
 * one, and (when max wakes already happened in the last 24 h) 24 h after the
 * one that has to drop out of the window. `wakes` are start times in ms.
 */
export function earliestAllowed(
  wakes: readonly number[],
  nowMs: number,
  { minGapMs, maxPer24h }: { minGapMs: number; maxPer24h: number },
): { at: number; reason: RailReason | null } {
  const sorted = [...wakes].sort((a, b) => a - b);
  let at = nowMs;
  let reason: RailReason | null = null;
  const last = sorted[sorted.length - 1];
  if (last !== undefined && last + minGapMs > at) {
    at = last + minGapMs;
    reason = 'min_gap';
  }
  const recent = sorted.filter((w) => w > nowMs - DAY_MS);
  if (recent.length >= maxPer24h) {
    const free = (recent[recent.length - maxPer24h] ?? nowMs) + DAY_MS;
    if (free > at) {
      at = free;
      reason = 'max_wakes_24h';
    }
  }
  return { at, reason };
}

// ---------------------------------------------------------------------------
// The affordability gate
// ---------------------------------------------------------------------------

/** One bid that left the wallet: when, and how much. */
export interface Spend {
  at: number;
  lamports: bigint;
}

/**
 * The moment enough of the oldest spends leave the rolling window for a bid
 * of `minimum` to fit under `cap`, or null when it never will (the minimum is
 * above the cap itself). The window matches `SpendLimits`: a spend at `t`
 * counts while `now - t <= 24 h`, so it leaves at `t + 24 h + 1 ms`.
 */
export function budgetFreesAt(
  spends: readonly Spend[],
  cap: bigint,
  minimum: bigint,
): number | null {
  if (minimum > cap) return null;
  const sorted = [...spends].sort((a, b) => a.at - b.at);
  let remaining = sorted.reduce((sum, s) => sum + s.lamports, 0n);
  if (remaining + minimum <= cap) return null;
  for (const spend of sorted) {
    remaining -= spend.lamports;
    if (remaining + minimum <= cap) return spend.at + WINDOW_MS + 1;
  }
  return null;
}

export interface GateInput {
  /** This agent's wallet, base58. */
  wallet: string;
  /** The board as last read. */
  poster: string;
  amount: bigint;
  maxBid: bigint;
  dailyCap: bigint;
  /** Gross spend in the rolling 24 h, from the activity log. */
  spent: bigint;
  /** The executed bids inside the window (for the exact wait). */
  spends: readonly Spend[];
  /** Read only when every other check passed. */
  balance: () => Promise<bigint>;
}

export type GateResult =
  | { ok: true; minimum: bigint }
  | { ok: false; kind: 'poster' }
  | {
      ok: false;
      kind: 'priced_out';
      minimum: bigint;
      limit: 'max_bid' | 'daily_cap';
      limitLamports: bigint;
    }
  | {
      ok: false;
      kind: 'waiting_for_budget';
      minimum: bigint;
      spent: bigint;
      dailyCap: bigint;
      until: number;
    }
  | {
      ok: false;
      kind: 'unfunded';
      minimum: bigint;
      balance: bigint;
      needed: bigint;
      shortfall: bigint;
    };

/**
 * Can the agent act right now? Pure apart from the balance read, which only
 * happens when nothing else stops the wake. The order is the design's: poster,
 * priced out, waiting for budget, unfunded.
 */
export async function evaluateGate(input: GateInput): Promise<GateResult> {
  if (input.poster === input.wallet) return { ok: false, kind: 'poster' };
  // A board nobody has posted to has a minimum of 0; a bid still has to be positive.
  const raw = minimumBid(input.amount);
  const minimum = raw > 0n ? raw : 1n;
  if (minimum > input.maxBid) {
    return {
      ok: false,
      kind: 'priced_out',
      minimum,
      limit: 'max_bid',
      limitLamports: input.maxBid,
    };
  }
  if (minimum > input.dailyCap) {
    return {
      ok: false,
      kind: 'priced_out',
      minimum,
      limit: 'daily_cap',
      limitLamports: input.dailyCap,
    };
  }
  if (input.spent + minimum > input.dailyCap) {
    const until = budgetFreesAt(input.spends, input.dailyCap, minimum);
    if (until !== null) {
      return {
        ok: false,
        kind: 'waiting_for_budget',
        minimum,
        spent: input.spent,
        dailyCap: input.dailyCap,
        until,
      };
    }
  }
  const balance = await input.balance();
  const needed = minimum + FEE_HEADROOM_LAMPORTS;
  if (balance < needed) {
    return { ok: false, kind: 'unfunded', minimum, balance, needed, shortfall: needed - balance };
  }
  return { ok: true, minimum };
}

/** The console sentence for a priced-out agent. */
export function pricedOutMessage(
  minimum: bigint,
  limitLamports: bigint,
  limit: 'max_bid' | 'daily_cap' = 'max_bid',
): string {
  const min = `${lamportsToSol(minimum)} SOL`;
  const lim = `${lamportsToSol(limitLamports)} SOL`;
  return limit === 'max_bid'
    ? `Priced out: the minimum bid (${min}) is above your per-bid limit (${lim}). The price only goes up, so this agent stays asleep unless you raise MAX_BID_SOL.`
    : `Priced out: the minimum bid (${min}) is above your 24-hour cap (${lim}). The price only goes up, so this agent stays asleep unless you raise DAILY_CAP_SOL.`;
}

/** The limits as `.env` holds them right now. */
export interface EnvLimits {
  maxBid: bigint;
  dailyCap: bigint;
  activityLogPath: string;
}

/**
 * Reads the limits from `.env` values the way the server does: MAX_BID_SOL is
 * required, DAILY_CAP_SOL defaults to it, ACTIVITY_LOG_PATH to the default
 * file in the folder. Throws with a plain sentence when a value is unusable.
 */
export function limitsFromEnv(env: Record<string, string>, dir: string): EnvLimits {
  const max = env.MAX_BID_SOL?.trim();
  if (!max) throw new Error('MAX_BID_SOL is not set in .env');
  let maxBid: bigint;
  try {
    maxBid = solToLamports(max);
  } catch {
    throw new Error(`MAX_BID_SOL in .env is not a SOL amount like 0.2`);
  }
  const cap = env.DAILY_CAP_SOL?.trim();
  let dailyCap = maxBid;
  if (cap) {
    try {
      dailyCap = solToLamports(cap);
    } catch {
      throw new Error(`DAILY_CAP_SOL in .env is not a SOL amount like 0.4`);
    }
  }
  const logPath = env.ACTIVITY_LOG_PATH?.trim() || DEFAULT_ACTIVITY_LOG_PATH;
  return { maxBid, dailyCap, activityLogPath: resolve(dir, logPath) };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface RunnerWake {
  ts: string;
  trigger: Trigger;
}

export interface RunnerState {
  version: 1;
  last_board_hash: string | null;
  last_poster: string | null;
  /** Lamports as a decimal string (JSON has no bigint). */
  last_amount: string | null;
  pending_reaction_at: string | null;
  next_look_at: string | null;
  first_wake_at: string | null;
  last_wake_at: string | null;
  wakes: RunnerWake[];
}

export const emptyState = (): RunnerState => ({
  version: 1,
  last_board_hash: null,
  last_poster: null,
  last_amount: null,
  pending_reaction_at: null,
  next_look_at: null,
  first_wake_at: null,
  last_wake_at: null,
  wakes: [],
});

/** Where state lives: the live file in the folder, dry and sandbox runs under logs/. */
export function statePath(
  paths: AgentPaths,
  { dryRun = false, sandbox = false }: { dryRun?: boolean; sandbox?: boolean } = {},
): string {
  if (dryRun) return join(paths.logs, 'runner-state.dry.json');
  if (sandbox) return join(paths.logs, 'runner-state.sandbox.json');
  return paths.runnerState;
}

export const hashData = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const ms = (iso: string | null): number | null => (iso ? Date.parse(iso) : null);
const iso = (t: number): string => new Date(t).toISOString();

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** What a wake reports back. `entry` is null when no wake happened (claude never started). */
export interface WakeOutcome {
  exitCode: number | null;
  entry: {
    decision: string | null;
    reason?: string | null;
    next_look_hours: number | null;
  } | null;
  error?: string;
}

export interface RunnerLogEntry {
  ts: string;
  event: string;
  [field: string]: unknown;
}

export interface RunnerDeps {
  /** Epoch milliseconds. */
  now(): number;
  /** [0, 1). */
  random(): number;
  rpc: RunnerRpc;
  wake(trigger: Trigger): Promise<WakeOutcome>;
  /** The folder's `.env` as key/value pairs. Default: read the file every call. */
  readEnv?: () => Record<string, string>;
  /** Every runner.log line, as written (the console prints from these). */
  onEvent?: (entry: RunnerLogEntry) => void;
}

export interface RunnerOptions {
  paths: AgentPaths;
  settings: AgentSettings;
  /** This agent's wallet, base58. */
  wallet: string;
  dryRun?: boolean;
  /** The gate is skipped: the simulated board lives inside the model's own server. */
  sandbox?: boolean;
  deps: RunnerDeps;
}

interface Board {
  poster: string;
  amount: bigint;
}

type GateStep = { pass: true } | { pass: false; back: number };

export class Runner {
  readonly paths: AgentPaths;
  readonly settings: AgentSettings;
  readonly wallet: string;
  readonly dryRun: boolean;
  readonly sandbox: boolean;
  readonly statePath: string;
  readonly logPath: string;
  state: RunnerState = emptyState();
  private readonly deps: RunnerDeps;
  private board: Board | null = null;
  private nextPollAt = 0;
  private backoffMs = 0;
  private retryAt = 0;
  private pauseNoted = false;
  private deferNoted: string | null = null;
  private gateNoted: string | null = null;
  private balanceCache: { lamports: bigint; at: number } | null = null;
  private balanceBackoffMs = 0;
  private balanceRetryAt = 0;
  private saved: string | null = null;

  constructor(options: RunnerOptions) {
    this.paths = options.paths;
    this.settings = options.settings;
    this.wallet = options.wallet;
    this.dryRun = options.dryRun ?? false;
    this.sandbox = options.sandbox ?? false;
    this.deps = options.deps;
    this.statePath = statePath(this.paths, { dryRun: this.dryRun, sandbox: this.sandbox });
    this.logPath = this.paths.runnerLog;
  }

  now(): number {
    return this.deps.now();
  }

  log(event: string, fields: Record<string, unknown> = {}): RunnerLogEntry {
    const entry: RunnerLogEntry = {
      ts: iso(this.now()),
      event,
      ...(this.dryRun ? { dry_run: true } : {}),
      ...(this.sandbox ? { sandbox: true } : {}),
      ...fields,
    };
    mkdirSync(this.paths.logs, { recursive: true });
    appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`);
    this.deps.onEvent?.(entry);
    return entry;
  }

  /** Writes state when it changed since the last write. */
  save(): void {
    const text = `${JSON.stringify(this.state, null, 2)}\n`;
    if (text === this.saved) return;
    writeFileAtomic(this.statePath, text);
    this.saved = text;
  }

  paused(): boolean {
    return existsSync(this.paths.pause);
  }

  /** Loads (or creates) state and draws the first-wake time if the agent has never been woken. */
  start(): void {
    mkdirSync(this.paths.logs, { recursive: true });
    let loaded: RunnerState | null = null;
    if (existsSync(this.statePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<RunnerState> | null;
        if (raw && raw.version === 1) {
          loaded = { ...emptyState(), ...raw, wakes: Array.isArray(raw.wakes) ? raw.wakes : [] };
        }
      } catch (err) {
        this.log('state_unreadable', { path: this.statePath, error: errorText(err) });
      }
    }
    this.state = loaded ?? emptyState();
    const now = this.now();
    if (!this.state.last_wake_at && !this.state.first_wake_at) {
      const delay = Math.round(
        uniform(this.deps.random, 0, this.settings.first_wake_max_min) * MIN_MS,
      );
      this.state.first_wake_at = iso(now + delay);
    }
    this.log('started', {
      wallet: this.wallet,
      state: this.statePath,
      resumed: loaded !== null,
      first_wake_at: this.state.last_wake_at ? null : this.state.first_wake_at,
      pending_reaction_at: this.state.pending_reaction_at,
      next_look_at: this.state.next_look_at,
    });
    this.save();
  }

  /** One read of the board. Returns true when it was read. Never throws. */
  async poll(): Promise<boolean> {
    const now = this.now();
    let data: Buffer;
    try {
      const account = await this.deps.rpc.getAccount(BILLBOARD_ADDRESS);
      if (!account) throw new Error(`billboard account ${BILLBOARD_ADDRESS.toBase58()} not found`);
      data = account;
    } catch (err) {
      this.backOff(now);
      this.log('poll_error', { error: errorText(err), retry_in_s: this.backoffMs / 1000 });
      return false;
    }
    this.backoffMs = 0;
    this.nextPollAt =
      now +
      Math.round(
        uniform(this.deps.random, this.settings.poll_min_s, this.settings.poll_max_s) * 1000,
      );
    const hash = hashData(data);
    if (hash === this.state.last_board_hash && this.board) return true;
    let decodeError: string | undefined;
    try {
      const decoded = decodeBillboard(data);
      this.board = { poster: decoded.poster.toBase58(), amount: decoded.amount };
    } catch (err) {
      this.board = null;
      decodeError = errorText(err);
    }
    if (hash === this.state.last_board_hash) return true; // first read after a restart
    const first = this.state.last_board_hash === null;
    const poster = this.board?.poster ?? null;
    this.state.last_board_hash = hash;
    this.state.last_poster = poster;
    this.state.last_amount = this.board ? this.board.amount.toString() : null;
    const seen = {
      poster,
      amount_sol: this.board ? lamportsToSol(this.board.amount) : null,
      hash: hash.slice(0, 16),
      ...(decodeError ? { decode_error: decodeError } : {}),
    };
    if (first) {
      // Nothing to compare with yet: this is the board the next wake will see.
      this.log('board_recorded', seen);
      return true;
    }
    this.log('change_seen', seen);
    if (poster === this.wallet) {
      this.log('own_post_ignored', { poster });
      return true;
    }
    if (this.state.pending_reaction_at) {
      this.log('reaction_kept', { at: this.state.pending_reaction_at });
      return true;
    }
    const delay = Math.round(
      uniform(this.deps.random, this.settings.react_min_min, this.settings.react_max_min) * MIN_MS,
    );
    this.state.pending_reaction_at = iso(now + delay);
    this.log('reaction_scheduled', {
      at: this.state.pending_reaction_at,
      delay_min: Math.round(delay / 6000) / 10,
    });
    return true;
  }

  private backOff(now: number): void {
    this.backoffMs = this.backoffMs
      ? Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
      : BACKOFF_START_MS;
    this.nextPollAt = now + this.backoffMs;
  }

  /** The trigger due now, or null. A board change wins over NEXT_LOOK and the first look. */
  dueTrigger(now: number): Trigger | null {
    const pending = ms(this.state.pending_reaction_at);
    const look = ms(this.state.next_look_at);
    const first = this.state.last_wake_at ? null : ms(this.state.first_wake_at);
    if (pending !== null && pending <= now) return 'board_changed';
    if (look !== null && look <= now) return 'self_chosen';
    if (first !== null && first <= now) return 'first';
    return null;
  }

  nextDueAt(): number {
    const times = [
      ms(this.state.pending_reaction_at),
      ms(this.state.next_look_at),
      this.state.last_wake_at ? null : ms(this.state.first_wake_at),
    ].filter((t): t is number => t !== null);
    return times.length ? Math.min(...times) : Infinity;
  }

  rails(now: number): { at: number; reason: RailReason | null } {
    return earliestAllowed(
      this.state.wakes.map((w) => Date.parse(w.ts)),
      now,
      { minGapMs: this.settings.min_gap_min * MIN_MS, maxPer24h: this.settings.max_wakes_24h },
    );
  }

  /** Logs a gate result once per distinct key; a pass clears the memory. */
  private noteGate(key: string, event: string, fields: Record<string, unknown>): void {
    if (this.gateNoted === key) return;
    this.gateNoted = key;
    this.log(event, fields);
  }

  private async balance(now: number): Promise<bigint> {
    if (this.balanceCache && now - this.balanceCache.at < BALANCE_CACHE_MS) {
      return this.balanceCache.lamports;
    }
    const lamports = await this.deps.rpc.getBalance(new PublicKey(this.wallet));
    this.balanceCache = { lamports, at: now };
    this.balanceBackoffMs = 0;
    return lamports;
  }

  /** The affordability gate on the board as last read. */
  async gate(now: number): Promise<GateStep> {
    if (this.sandbox) return { pass: true };
    const board = this.board;
    if (!board) return { pass: false, back: this.nextPollAt };
    if (now < this.balanceRetryAt) return { pass: false, back: this.balanceRetryAt };
    let limits: EnvLimits;
    try {
      limits = limitsFromEnv(
        (this.deps.readEnv ?? (() => readEnvFile(this.paths.env)))(),
        this.paths.dir,
      );
    } catch (err) {
      const message = errorText(err);
      this.noteGate(`limits_invalid:${message}`, 'limits_invalid', { error: message });
      return { pass: false, back: now + MAX_SLEEP_MS };
    }
    const log = new ActivityLog(limits.activityLogPath);
    const clock = { now: () => new Date(now) };
    const spent = new SpendLimits(
      log,
      { maxBidLamports: limits.maxBid, dailyCapLamports: limits.dailyCap },
      clock,
    ).spentLast24h();
    const spends: Spend[] = log
      .entriesSince(now - WINDOW_MS)
      .filter((e) => e.event === 'executed' && e.bid_sol !== undefined)
      .map((e) => ({ at: Date.parse(e.ts), lamports: solToLamports(e.bid_sol as string) }));
    let result: GateResult;
    try {
      result = await evaluateGate({
        wallet: this.wallet,
        poster: board.poster,
        amount: board.amount,
        maxBid: limits.maxBid,
        dailyCap: limits.dailyCap,
        spent,
        spends,
        balance: () => this.balance(now),
      });
    } catch (err) {
      // The balance read failed: no wake on a guess. It backs off on its own
      // schedule, since the board reads in between may well succeed.
      this.balanceBackoffMs = this.balanceBackoffMs
        ? Math.min(this.balanceBackoffMs * 2, BACKOFF_MAX_MS)
        : BACKOFF_START_MS;
      this.balanceRetryAt = now + this.balanceBackoffMs;
      this.log('balance_error', {
        error: errorText(err),
        retry_in_s: this.balanceBackoffMs / 1000,
      });
      return { pass: false, back: this.balanceRetryAt };
    }
    const hash = this.state.last_board_hash ?? '';
    if (result.ok) {
      this.gateNoted = null;
      return { pass: true };
    }
    switch (result.kind) {
      case 'poster':
        this.noteGate(`poster:${hash}`, 'skipped_poster', { poster: board.poster });
        return { pass: false, back: this.nextPollAt };
      case 'priced_out':
        this.noteGate(`priced_out:${hash}:${result.limit}:${result.limitLamports}`, 'priced_out', {
          minimum_sol: lamportsToSol(result.minimum),
          limit: result.limit,
          limit_sol: lamportsToSol(result.limitLamports),
          message: pricedOutMessage(result.minimum, result.limitLamports, result.limit),
        });
        return { pass: false, back: this.nextPollAt };
      case 'waiting_for_budget':
        this.noteGate(`waiting:${result.until}:${result.minimum}`, 'waiting_for_budget', {
          minimum_sol: lamportsToSol(result.minimum),
          spent_24h_sol: lamportsToSol(result.spent),
          daily_cap_sol: lamportsToSol(result.dailyCap),
          until: iso(result.until),
        });
        return { pass: false, back: Math.min(result.until, this.nextPollAt) };
      case 'unfunded':
        this.noteGate(`unfunded:${result.needed}:${result.balance}`, 'unfunded', {
          minimum_sol: lamportsToSol(result.minimum),
          balance_sol: lamportsToSol(result.balance),
          needed_sol: lamportsToSol(result.needed),
          shortfall_sol: lamportsToSol(result.shortfall),
        });
        return { pass: false, back: this.nextPollAt };
    }
  }

  /** One pass: poll if due, wake if due, affordable and allowed. Returns when to come back (ms). */
  async step(): Promise<number> {
    let polled = false;
    if (this.now() >= this.nextPollAt) {
      await this.poll();
      polled = true;
    }
    const pause = this.paused();
    if (pause && !this.pauseNoted) this.log('paused', { due: this.dueTrigger(this.now()) });
    if (!pause && this.pauseNoted) this.log('resumed', { due: this.dueTrigger(this.now()) });
    this.pauseNoted = pause;
    const now = this.now();
    const trigger = this.dueTrigger(now);
    let back: number;
    if (pause)
      back = now + MAX_SLEEP_MS; // keep polling, never wake
    else if (!trigger) back = this.nextDueAt();
    else if (now < this.retryAt) back = this.retryAt;
    else {
      const gate = await this.gate(now);
      if (!gate.pass) back = gate.back;
      else {
        const allowed = this.rails(now);
        if (allowed.at > now) {
          const key = `${trigger}@${allowed.at}`;
          if (this.deferNoted !== key) {
            this.log('deferred', { trigger, until: iso(allowed.at), reason: allowed.reason });
          }
          this.deferNoted = key;
          back = allowed.at;
        } else {
          back = await this.wakeIfStillAffordable(trigger, polled);
        }
      }
    }
    this.save();
    return Math.min(this.nextPollAt, back);
  }

  /** A fresh read first (the board the agent is about to see), the gate again on it, then the wake. */
  private async wakeIfStillAffordable(trigger: Trigger, polled: boolean): Promise<number> {
    if (!polled) {
      if (!(await this.poll())) return this.nextPollAt;
      const gate = await this.gate(this.now());
      if (!gate.pass) return gate.back;
    }
    await this.wake(trigger);
    return this.nextDueAt();
  }

  async wake(trigger: Trigger): Promise<void> {
    const hashAtWake = this.state.last_board_hash;
    const started = this.now();
    let result: WakeOutcome = { exitCode: null, entry: null };
    if (this.dryRun) {
      this.log('would_wake', { trigger });
    } else {
      this.log('wake_started', { trigger });
      try {
        result = await this.deps.wake(trigger);
      } catch (err) {
        result = { exitCode: null, entry: null, error: errorText(err) };
      }
    }
    const ended = this.now();
    // The agent may have bid: read the balance fresh next time.
    this.balanceCache = null;
    if (!this.dryRun && !result.entry) {
      // The model never started: nothing was seen, so the trigger stays and is retried.
      this.retryAt = ended + RETRY_AFTER_SKIP_MS;
      this.log('wake_finished', {
        trigger,
        exit_code: result.exitCode,
        skipped: 'no wake',
        ...(result.error ? { error: result.error } : {}),
        retry_at: iso(this.retryAt),
      });
      return;
    }
    // Every wake, whatever its trigger, has seen the latest board.
    this.state.wakes = [...this.state.wakes, { ts: iso(started), trigger }].filter(
      (w) => Date.parse(w.ts) > ended - WAKES_KEPT_MS,
    );
    this.state.last_wake_at = iso(started);
    this.state.pending_reaction_at = null;
    this.state.last_board_hash = hashAtWake;
    this.deferNoted = null;
    const hours = result.entry?.next_look_hours ?? null;
    const look = nextLookDelay(hours, {
      minH: this.settings.next_look_min_h,
      maxH: this.settings.next_look_max_h,
      random: this.deps.random,
    });
    this.state.next_look_at = iso(ended + look.ms);
    if (!this.dryRun) {
      const e = result.entry;
      this.log('wake_finished', {
        trigger,
        exit_code: result.exitCode,
        duration_s: Math.round((ended - started) / 100) / 10,
        decision: e?.decision ?? null,
        ...(e?.reason ? { reason: e.reason } : {}),
        next_look_hours: hours,
        next_look_at: this.state.next_look_at,
      });
    }
    if (look.defaulted) {
      this.log('next_look_defaulted', { given: hours, next_look_at: this.state.next_look_at });
    }
  }

  stop(reason: string): void {
    this.log('stopped', { reason });
    this.save();
  }
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * Runs the runner until `endAt` or until `signal` aborts. `sleep` waits (tests
 * pass a fake clock that just moves time on). An error in a step is logged
 * and never ends the loop.
 */
export async function runLoop(
  runner: Runner,
  { sleep, endAt = Infinity, signal }: { sleep: Sleep; endAt?: number; signal?: AbortSignal },
): Promise<void> {
  runner.start();
  while (!signal?.aborted && runner.now() < endAt) {
    let back: number;
    try {
      back = await runner.step();
    } catch (err) {
      try {
        runner.log('runner_error', { error: errorText(err) });
      } catch {
        /* the log itself failed: keep going */
      }
      back = runner.now() + MAX_SLEEP_MS;
    }
    const now = runner.now();
    const until = Math.min(back, endAt, now + MAX_SLEEP_MS);
    await sleep(Math.max(1000, until - now), signal);
  }
  runner.stop(signal?.aborted ? 'signal' : 'minutes elapsed');
}

/** A real sleep that an abort ends early. */
export const realSleep: Sleep = (delay, signal) =>
  new Promise((done) => {
    const timer = setTimeout(done, delay);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
