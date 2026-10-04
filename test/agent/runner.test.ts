/**
 * src/agent/runner.ts: the fleet's timing rules (ported) and the affordability
 * gate, proven on a fake clock against MockRpc with a fake wake. No network,
 * no model: `wake` is a function that records the call and moves the clock.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agentPaths, parseAgentSettings, type AgentPaths } from '../../src/agent/folder.js';
import {
  BACKOFF_MAX_MS,
  BACKOFF_START_MS,
  BALANCE_CACHE_MS,
  FEE_HEADROOM_LAMPORTS,
  RETRY_AFTER_SKIP_MS,
  Runner,
  budgetFreesAt,
  earliestAllowed,
  evaluateGate,
  hashData,
  limitsFromEnv,
  nextLookDelay,
  pricedOutMessage,
  runLoop,
  statePath,
  type GateInput,
  type RunnerLogEntry,
  type RunnerState,
  type Trigger,
  type WakeOutcome,
} from '../../src/agent/runner.js';
import { ActivityLog } from '../../src/log/activity.js';
import { BILLBOARD_ADDRESS } from '../../src/program/layout.js';
import { solToLamports } from '../../src/program/math.js';
import { MockRpc } from '../../src/rpc/MockRpc.js';
import { SpendLimits, WINDOW_MS } from '../../src/spend/limits.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.parse('2026-10-04T00:00:00.000Z');
const SOL = 1_000_000_000n;

let root: string;
let paths: AgentPaths;
// In memory only: never written to disk, never funded.
let wallet: Keypair;
let outsider: Keypair;
let rival: Keypair;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abm-runner-'));
  paths = agentPaths('agent', root);
  mkdirSync(paths.dir);
  wallet = Keypair.generate();
  outsider = Keypair.generate();
  rival = Keypair.generate();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PASSED: WakeOutcome['entry'] = {
  decision: 'passed',
  reason: 'not worth it',
  next_look_hours: 6,
};

interface HarnessOptions {
  seed?: number;
  settings?: Record<string, unknown>;
  /** .env values; mutable so a test can raise a limit mid-run. null = read the real file. */
  env?: Record<string, string> | null;
  /** Lamports the board holds at start (min = +1%). Default 0.1 SOL. */
  amount?: bigint;
  /** Lamports in the wallet. Default 1 SOL. */
  balance?: bigint;
  wakeResult?: WakeOutcome['entry'] | ((trigger: Trigger, n: number) => WakeOutcome['entry']);
  wakeMs?: number;
  clockAt?: number;
  dryRun?: boolean;
  sandbox?: boolean;
  mock?: MockRpc;
}

/**
 * A runner on a fake clock. `at(t, fn)` runs `fn` when the clock reaches `t`
 * (the fake sleep stops there). The fake wake takes `wakeMs`.
 */
function harness(options: HarnessOptions = {}) {
  const clock = { t: options.clockAt ?? START };
  const mock =
    options.mock ??
    new MockRpc({ poster: outsider.publicKey, amount: options.amount ?? SOL / 10n });
  mock.setBalance(wallet.publicKey, options.balance ?? SOL);
  const env =
    options.env === null ? null : (options.env ?? { MAX_BID_SOL: '0.5', DAILY_CAP_SOL: '1' });
  const rpc = {
    reads: [] as number[],
    balanceReads: [] as number[],
    fail: 0,
    failBalance: 0,
    getAccount: async (key: PublicKey) => {
      rpc.reads.push(clock.t);
      if (rpc.fail > 0) {
        rpc.fail--;
        throw new Error('fake RPC: 503');
      }
      return mock.getAccount(key);
    },
    getBalance: async (key: PublicKey) => {
      rpc.balanceReads.push(clock.t);
      if (rpc.failBalance > 0) {
        rpc.failBalance--;
        throw new Error('fake RPC: balance 503');
      }
      return mock.getBalance(key);
    },
  };
  const wakes: { trigger: Trigger; at: number }[] = [];
  const seen: RunnerLogEntry[] = [];
  const events: { at: number; run: () => unknown; done?: boolean }[] = [];
  const runner = new Runner({
    paths,
    settings: parseAgentSettings(options.settings ?? {}),
    wallet: wallet.publicKey.toBase58(),
    dryRun: options.dryRun ?? false,
    sandbox: options.sandbox ?? false,
    deps: {
      now: () => clock.t,
      random: mulberry32(options.seed ?? 1),
      rpc,
      ...(env === null ? {} : { readEnv: () => ({ ...env }) }),
      onEvent: (e) => seen.push(e),
      wake: async (trigger) => {
        wakes.push({ trigger, at: clock.t });
        const r = options.wakeResult === undefined ? PASSED : options.wakeResult;
        const entry = typeof r === 'function' ? r(trigger, wakes.length) : r;
        clock.t += options.wakeMs ?? 2 * MIN;
        return { exitCode: 0, entry };
      },
    },
  });
  const sleep = async (d: number) => {
    const target = clock.t + d;
    const ev = events.filter((e) => !e.done && e.at <= target).sort((x, y) => x.at - y.at)[0];
    if (ev) {
      clock.t = Math.max(clock.t, ev.at);
      ev.done = true;
      await ev.run();
    } else clock.t = target;
  };
  return {
    clock,
    mock,
    rpc,
    env,
    wakes,
    seen,
    runner,
    at: (at: number, run: () => unknown) => events.push({ at, run }),
    run: (forMs: number) => runLoop(runner, { sleep, endAt: clock.t + forMs }),
  };
}

const runnerLog = (): RunnerLogEntry[] =>
  existsSync(paths.runnerLog)
    ? readFileSync(paths.runnerLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RunnerLogEntry)
    : [];
const events = (name: string) => runnerLog().filter((e) => e.event === name);
const state = (file = paths.runnerState): RunnerState =>
  JSON.parse(readFileSync(file, 'utf8')) as RunnerState;
const at = (e: RunnerLogEntry | undefined) => Date.parse(String(e?.ts));

/** Appends an executed bid to the folder's real activity log. */
function spent(ts: number, bidSol: string): void {
  new ActivityLog(paths.activityLog).append({
    ts: new Date(ts).toISOString(),
    event: 'executed',
    tool: 'acquire_posting_rights',
    bid_sol: bidSol,
    tx: `sig-${ts}`,
    reasoning: 'fixture',
  });
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

describe('triggers', () => {
  it('first: one wake inside 0..first_wake_max_min, then NEXT_LOOK ±10% from the end of the wake', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      rmSync(paths.dir, { recursive: true, force: true });
      mkdirSync(paths.dir);
      const h = harness({ seed });
      await h.run(100 * MIN);
      const firstAt = Date.parse(String(events('started')[0]?.first_wake_at));
      expect(firstAt).toBeGreaterThanOrEqual(START);
      expect(firstAt).toBeLessThanOrEqual(START + 5 * MIN);
      expect(h.wakes).toHaveLength(1);
      expect(h.wakes[0]?.trigger).toBe('first');
      expect(h.wakes[0]!.at - firstAt).toBeLessThanOrEqual(1000);
      const s = state();
      const look = Date.parse(s.next_look_at!) - (h.wakes[0]!.at + 2 * MIN);
      expect(look).toBeGreaterThanOrEqual(5.4 * HOUR);
      expect(look).toBeLessThanOrEqual(6.6 * HOUR);
      expect(s.wakes).toEqual([{ ts: s.last_wake_at, trigger: 'first' }]);
      expect(s.last_poster).toBe(outsider.publicKey.toBase58());
      expect(s.last_amount).toBe('100000000');
      expect(s.last_board_hash).toBe(hashData((await h.mock.getAccount(BILLBOARD_ADDRESS))!));
    }
  });

  it('board_changed: one reaction inside react_min_min..react_max_min, and a handled change never fires again', async () => {
    for (let seed = 1; seed <= 5; seed++) {
      rmSync(paths.dir, { recursive: true, force: true });
      mkdirSync(paths.dir);
      const h = harness({ seed });
      h.at(START + 3 * HOUR, () => h.mock.acquireAs(rival, 150_000_000n, 'the other side'));
      await h.run(6 * HOUR);
      const seen = events('change_seen');
      expect(seen).toHaveLength(1);
      expect(seen[0]?.poster).toBe(rival.publicKey.toBase58());
      expect(seen[0]?.amount_sol).toBe('0.15');
      const seenAt = at(seen[0]);
      // Seen at the next poll: within poll_max_s (180 s) of the change.
      expect(seenAt - (START + 3 * HOUR)).toBeLessThanOrEqual(180_000);
      const scheduled = events('reaction_scheduled');
      expect(scheduled).toHaveLength(1);
      const delay = Date.parse(String(scheduled[0]?.at)) - seenAt;
      expect(delay).toBeGreaterThanOrEqual(10 * MIN);
      expect(delay).toBeLessThanOrEqual(60 * MIN);
      const reactions = h.wakes.filter((w) => w.trigger === 'board_changed');
      expect(reactions).toHaveLength(1);
      expect(reactions[0]!.at - Date.parse(String(scheduled[0]?.at))).toBeLessThanOrEqual(1000);
      expect(state().pending_reaction_at).toBeNull();
      expect(state().last_poster).toBe(rival.publicKey.toBase58());
    }
  });

  it('self_chosen: NEXT_LOOK whole hours clamp to next_look_min_h..max_h with ±10%; anything else is 3..12 h', async () => {
    const lo = () => 0;
    const hi = () => 0.999999;
    expect(nextLookDelay(6, { random: lo }).ms).toBe(6 * HOUR * 0.9);
    expect(Math.abs(nextLookDelay(6, { random: hi }).ms - 6 * HOUR * 1.1)).toBeLessThan(1000);
    expect([
      nextLookDelay(0, { random: lo }).hours,
      nextLookDelay(-3, { random: lo }).hours,
    ]).toEqual([1, 1]);
    expect(nextLookDelay(30, { random: lo }).hours).toBe(24);
    expect(nextLookDelay(24, { random: hi }).defaulted).toBe(false);
    for (const bad of [null, undefined, 3.5, '6', Number.NaN, {}]) {
      const d = nextLookDelay(bad, { random: lo });
      expect(d.defaulted).toBe(true);
      expect(d.ms).toBe(3 * HOUR);
      expect(nextLookDelay(bad, { random: hi }).ms).toBeLessThanOrEqual(12 * HOUR);
    }
    // In the runner: the agent asked for 2 h, then gave nothing usable.
    const h = harness({
      settings: { first_wake_max_min: 0 },
      wakeResult: (_t, n) =>
        n === 1
          ? { decision: 'passed', next_look_hours: 2 }
          : { decision: 'error', next_look_hours: null },
    });
    await h.run(3 * HOUR);
    expect(h.wakes.map((w) => w.trigger)).toEqual(['first', 'self_chosen']);
    const gap = h.wakes[1]!.at - (h.wakes[0]!.at + 2 * MIN);
    expect(gap).toBeGreaterThanOrEqual(1.8 * HOUR);
    expect(gap).toBeLessThanOrEqual(2.2 * HOUR + 1000);
    const [d] = events('next_look_defaulted');
    expect(d?.given).toBeNull();
    const look = Date.parse(state().next_look_at!) - (h.wakes[1]!.at + 2 * MIN);
    expect(look).toBeGreaterThanOrEqual(3 * HOUR);
    expect(look).toBeLessThanOrEqual(12 * HOUR);
  });

  it('own post: a change to this wallet is recorded and ignored, and the poster gate keeps it asleep', async () => {
    const h = harness();
    h.at(START + 3 * HOUR, () => h.mock.acquireAs(wallet, 150_000_000n, 'mine'));
    await h.run(12 * HOUR);
    expect(events('own_post_ignored')).toHaveLength(1);
    expect(events('reaction_scheduled')).toHaveLength(0);
    // The first look happened; the 6 h self-chosen look found this wallet on the board.
    expect(h.wakes.map((w) => w.trigger)).toEqual(['first']);
    const skipped = events('skipped_poster');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.poster).toBe(wallet.publicKey.toBase58());
    expect(state().last_poster).toBe(wallet.publicKey.toBase58());
    // Outbid: the overdue 6 h look can act now, so it fires at once; that wake has seen
    // the change, so the reaction is dropped rather than waking the agent twice.
    h.at(h.clock.t + HOUR, () => h.mock.acquireAs(rival, 200_000_000n));
    await h.run(3 * HOUR);
    expect(h.wakes.map((w) => w.trigger)).toEqual(['first', 'self_chosen']);
    expect(h.wakes[1]!.at - (h.clock.t - 3 * HOUR + HOUR)).toBeLessThanOrEqual(180_000);
    expect(state().pending_reaction_at).toBeNull();
  });

  it('a second change while a reaction is pending keeps the earlier time', async () => {
    const h = harness({ seed: 3, settings: { react_min_min: 30, react_max_min: 60 } });
    h.at(START + 3 * HOUR, () => h.mock.acquireAs(rival, 150_000_000n));
    h.at(START + 3 * HOUR + 10 * MIN, () => h.mock.acquireAs(outsider, 160_000_000n));
    await h.run(6 * HOUR);
    expect(events('change_seen')).toHaveLength(2);
    expect(events('reaction_scheduled')).toHaveLength(1);
    expect(events('reaction_kept')[0]?.at).toBe(events('reaction_scheduled')[0]?.at);
    const reactions = h.wakes.filter((w) => w.trigger === 'board_changed');
    expect(reactions).toHaveLength(1);
    expect(state().last_poster).toBe(outsider.publicKey.toBase58());
  });
});

// ---------------------------------------------------------------------------
// Rails
// ---------------------------------------------------------------------------

describe('rails', () => {
  it('earliestAllowed on its own', () => {
    const rails = { minGapMs: 30 * MIN, maxPer24h: 2 };
    expect(earliestAllowed([], START, rails)).toEqual({ at: START, reason: null });
    expect(earliestAllowed([START - 10 * MIN], START, rails)).toEqual({
      at: START + 20 * MIN,
      reason: 'min_gap',
    });
    expect(earliestAllowed([START - 5 * HOUR, START - 2 * HOUR], START, rails)).toEqual({
      at: START + 19 * HOUR,
      reason: 'max_wakes_24h',
    });
    expect(earliestAllowed([START - 25 * HOUR, START - 2 * HOUR], START, rails)).toEqual({
      at: START,
      reason: null,
    });
  });

  it('min_gap_min defers a reaction to the earliest allowed moment, logged once', async () => {
    const h = harness({ settings: { first_wake_max_min: 0, react_min_min: 1, react_max_min: 2 } });
    h.at(START + 3 * MIN, () => h.mock.acquireAs(rival, 150_000_000n));
    await h.run(2 * HOUR);
    expect(h.wakes[0]).toEqual({ trigger: 'first', at: START });
    const deferred = events('deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({
      trigger: 'board_changed',
      reason: 'min_gap',
      until: new Date(START + 30 * MIN).toISOString(),
    });
    expect(h.wakes[1]?.trigger).toBe('board_changed');
    expect(h.wakes[1]!.at - (START + 30 * MIN)).toBeLessThanOrEqual(1000);
    expect(h.wakes[1]!.at).toBeGreaterThanOrEqual(START + 30 * MIN);
  });

  it('max_wakes_24h defers until the oldest wake leaves the window', async () => {
    const h = harness({
      settings: { first_wake_max_min: 0, max_wakes_24h: 3 },
      wakeResult: { decision: 'passed', next_look_hours: 1 },
    });
    await h.run(30 * HOUR);
    const times = h.wakes.map((w) => w.at);
    expect(h.wakes.slice(0, 3).map((w) => w.trigger)).toEqual([
      'first',
      'self_chosen',
      'self_chosen',
    ]);
    const capped = events('deferred').filter((e) => e.reason === 'max_wakes_24h');
    expect(capped[0]?.until).toBe(new Date(START + 24 * HOUR).toISOString());
    expect(h.wakes[3]!.at).toBeGreaterThanOrEqual(START + 24 * HOUR);
    expect(h.wakes[3]!.at - (START + 24 * HOUR)).toBeLessThanOrEqual(1000);
    for (const t of times) {
      expect(times.filter((u) => u > t - 24 * HOUR && u <= t).length).toBeLessThanOrEqual(3);
    }
    for (let i = 1; i < times.length; i++)
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(30 * MIN);
  });

  it('PAUSE keeps polling and never wakes; removing it resumes', async () => {
    writeFileSync(paths.pause, '');
    const h = harness({ settings: { first_wake_max_min: 0 } });
    h.at(START + 3 * HOUR, () => rmSync(paths.pause));
    await h.run(3 * HOUR - MIN);
    expect(h.wakes).toHaveLength(0);
    expect(h.rpc.reads.length).toBeGreaterThanOrEqual(60);
    expect(events('paused')).toHaveLength(1);
    expect(events('paused')[0]?.due).toBe('first');
    await h.run(5 * MIN);
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]!.at).toBeLessThanOrEqual(START + 3 * HOUR + MIN);
    expect(events('resumed')).toHaveLength(1);
  });

  it('RPC failures back off from 30 s doubling to 10 min, never crash, and reset on success', async () => {
    const h = harness({
      settings: { first_wake_max_min: 0 },
      wakeMs: 0,
      wakeResult: { decision: 'passed', next_look_hours: 24 },
    });
    h.rpc.fail = 8;
    await h.run(2 * HOUR);
    const errors = events('poll_error');
    expect(errors.map((e) => e.retry_in_s)).toEqual([30, 60, 120, 240, 480, 600, 600, 600]);
    const gaps = h.rpc.reads.slice(1, 9).map((t, i) => (t - h.rpc.reads[i]!) / 1000);
    expect(gaps).toEqual([30, 60, 120, 240, 480, 600, 600, 600]);
    expect(BACKOFF_START_MS).toBe(30_000);
    expect(BACKOFF_MAX_MS).toBe(600_000);
    const normal = (h.rpc.reads[9]! - h.rpc.reads[8]!) / 1000;
    expect(normal).toBeGreaterThanOrEqual(60);
    expect(normal).toBeLessThanOrEqual(180);
    expect(events('board_recorded')).toHaveLength(1);
    // No board means no gate can pass: the first look waited for the RPC.
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]!.at).toBeGreaterThanOrEqual(h.rpc.reads[8]!);
  });

  it('a wake that never started is not counted and is retried after 10 min', async () => {
    const h = harness({
      settings: { first_wake_max_min: 0 },
      wakeMs: 0,
      wakeResult: (_t, n) => (n === 1 ? null : PASSED),
    });
    await h.run(30 * MIN);
    const finished = events('wake_finished');
    expect(finished[0]?.skipped).toBe('no wake');
    expect(h.wakes.map((w) => w.trigger)).toEqual(['first', 'first']);
    expect(h.wakes[1]!.at - h.wakes[0]!.at).toBe(RETRY_AFTER_SKIP_MS);
    expect(state().wakes).toHaveLength(1);
  });

  it('state survives a restart: no second first look, NEXT_LOOK kept, a change while down is seen', async () => {
    const mock = new MockRpc({ poster: outsider.publicKey, amount: SOL / 10n });
    const a = harness({ seed: 5, mock });
    await a.run(2 * HOUR);
    expect(a.wakes.map((w) => w.trigger)).toEqual(['first']);
    const saved = state();
    await mock.acquireAs(rival, 150_000_000n);
    const b = harness({ seed: 6, mock, clockAt: START + 3 * HOUR });
    await b.run(2 * HOUR);
    const started = events('started');
    expect(started).toHaveLength(2);
    expect(started[1]).toMatchObject({
      resumed: true,
      first_wake_at: null,
      next_look_at: saved.next_look_at,
    });
    expect(events('change_seen')).toHaveLength(1);
    expect(b.wakes.map((w) => w.trigger)).toEqual(['board_changed']);
    expect(state().wakes).toHaveLength(2);
    // A corrupt state file is logged and treated as no state.
    writeFileSync(paths.runnerState, '{ not json');
    const c = harness({ clockAt: START + 6 * HOUR, mock });
    await c.run(MIN);
    expect(events('state_unreadable')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The affordability gate
// ---------------------------------------------------------------------------

const W = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();

function gateInput(over: Partial<GateInput> = {}): GateInput {
  return {
    wallet: W,
    poster: OTHER,
    amount: 100_000_000n,
    maxBid: 200_000_000n,
    dailyCap: 400_000_000n,
    spent: 0n,
    spends: [],
    balance: async () => SOL,
    ...over,
  };
}

describe('the affordability gate', () => {
  it('evaluateGate: each branch, in the design order, reading the balance only when needed', async () => {
    let reads = 0;
    const counted = async () => {
      reads++;
      return SOL;
    };
    expect(await evaluateGate(gateInput({ balance: counted }))).toEqual({
      ok: true,
      minimum: 101_000_000n,
    });
    expect(reads).toBe(1);
    // Poster wins over everything, even priced out.
    expect(
      await evaluateGate(gateInput({ poster: W, amount: 10n * SOL, balance: counted })),
    ).toEqual({
      ok: false,
      kind: 'poster',
    });
    expect(await evaluateGate(gateInput({ amount: 300_000_000n, balance: counted }))).toEqual({
      ok: false,
      kind: 'priced_out',
      minimum: 303_000_000n,
      limit: 'max_bid',
      limitLamports: 200_000_000n,
    });
    // A cap below the minimum (an edited .env) is priced out too: there is no wait that helps.
    expect(
      await evaluateGate(gateInput({ maxBid: SOL, dailyCap: 100_000_000n, balance: counted })),
    ).toMatchObject({ ok: false, kind: 'priced_out', limit: 'daily_cap' });
    // Budget: spent 0.3 of 0.4, minimum 0.101.
    const budget = await evaluateGate(
      gateInput({
        spent: 300_000_000n,
        spends: [{ at: START, lamports: 300_000_000n }],
        balance: counted,
      }),
    );
    expect(budget).toEqual({
      ok: false,
      kind: 'waiting_for_budget',
      minimum: 101_000_000n,
      spent: 300_000_000n,
      dailyCap: 400_000_000n,
      until: START + WINDOW_MS + 1,
    });
    expect(reads).toBe(1);
    // Unfunded: needs minimum + 0.01 SOL.
    expect(await evaluateGate(gateInput({ balance: async () => 111_000_000n - 1n }))).toEqual({
      ok: false,
      kind: 'unfunded',
      minimum: 101_000_000n,
      balance: 110_999_999n,
      needed: 111_000_000n,
      shortfall: 1n,
    });
    expect(await evaluateGate(gateInput({ balance: async () => 111_000_000n }))).toMatchObject({
      ok: true,
    });
    expect(FEE_HEADROOM_LAMPORTS).toBe(10_000_000n);
    // A board nobody has posted to: the minimum is 0, a bid still needs a lamport.
    expect(await evaluateGate(gateInput({ amount: 0n }))).toEqual({ ok: true, minimum: 1n });
  });

  it('budgetFreesAt against a hand-checked fixture', () => {
    // Cap 0.5 SOL. Spends: 0.1 at T-20h, 0.15 at T-10h, 0.2 at T-2h → 0.45 spent.
    const T = START;
    const spends = [
      { at: T - 2 * HOUR, lamports: 200_000_000n },
      { at: T - 20 * HOUR, lamports: 100_000_000n },
      { at: T - 10 * HOUR, lamports: 150_000_000n },
    ];
    const cap = 500_000_000n;
    // Minimum 0.05: 0.45 + 0.05 = 0.5 fits exactly (a bid on the cap is allowed) → no wait.
    expect(budgetFreesAt(spends, cap, 50_000_000n)).toBeNull();
    // Minimum 0.12: need spent ≤ 0.38. Dropping 0.1 (T-20h) leaves 0.35 ✓ → T-20h+24h+1ms = T+4h+1ms.
    expect(budgetFreesAt(spends, cap, 120_000_000n)).toBe(T + 4 * HOUR + 1);
    // Minimum 0.3: need spent ≤ 0.2. Drop 0.1 → 0.35 ✗; drop 0.15 (T-10h) → 0.2 ✓ → T+14h+1ms.
    expect(budgetFreesAt(spends, cap, 300_000_000n)).toBe(T + 14 * HOUR + 1);
    // Minimum 0.5: need spent ≤ 0 → all three gone, the last at T-2h → T+22h+1ms.
    expect(budgetFreesAt(spends, cap, 500_000_000n)).toBe(T + 22 * HOUR + 1);
    // Minimum 0.51 is above the cap itself: no moment ever frees it.
    expect(budgetFreesAt(spends, cap, 510_000_000n)).toBeNull();
    // The server's own SpendLimits agrees at the boundary: refused 1 ms before, allowed at it.
    const logPath = join(root, 'fixture.jsonl');
    const log = new ActivityLog(logPath);
    for (const s of spends) {
      log.append({
        ts: new Date(s.at).toISOString(),
        event: 'executed',
        tool: 'acquire_posting_rights',
        bid_sol: (Number(s.lamports) / 1e9).toString(),
      });
    }
    const limitsAt = (t: number) =>
      new SpendLimits(
        log,
        { maxBidLamports: cap, dailyCapLamports: cap },
        { now: () => new Date(t) },
      );
    expect(limitsAt(T).spentLast24h()).toBe(450_000_000n);
    expect(limitsAt(T + 4 * HOUR).checkBid(120_000_000n).ok).toBe(false);
    expect(limitsAt(T + 4 * HOUR + 1).checkBid(120_000_000n).ok).toBe(true);
    expect(limitsAt(T + 14 * HOUR).checkBid(300_000_000n).ok).toBe(false);
    expect(limitsAt(T + 14 * HOUR + 1).checkBid(300_000_000n).ok).toBe(true);
  });

  it('priced out: zero wakes, one log line per board state with the locked sentence; raising MAX_BID_SOL wakes it', async () => {
    // Board at 0.3 → minimum 0.303, limit 0.2.
    const h = harness({ amount: 300_000_000n, env: { MAX_BID_SOL: '0.2', DAILY_CAP_SOL: '0.4' } });
    await h.run(30 * HOUR);
    expect(h.wakes).toHaveLength(0);
    expect(h.rpc.balanceReads).toHaveLength(0);
    const priced = events('priced_out');
    expect(priced).toHaveLength(1);
    expect(priced[0]).toMatchObject({ minimum_sol: '0.303', limit: 'max_bid', limit_sol: '0.2' });
    expect(priced[0]?.message).toBe(
      'Priced out: the minimum bid (0.303 SOL) is above your per-bid limit (0.2 SOL). The price only goes up, so this agent stays asleep unless you raise MAX_BID_SOL.',
    );
    expect(pricedOutMessage(303_000_000n, 200_000_000n)).toBe(priced[0]?.message);
    // The board moves on: a new state, one more line, still no wake.
    h.at(h.clock.t + HOUR, () => h.mock.acquireAs(rival, 400_000_000n));
    await h.run(3 * HOUR);
    expect(events('priced_out')).toHaveLength(2);
    expect(events('priced_out')[1]?.minimum_sol).toBe('0.404');
    expect(h.wakes).toHaveLength(0);
    // The operator raises the limit in .env: the next cycle passes the gate.
    h.env!.MAX_BID_SOL = '0.5';
    h.env!.DAILY_CAP_SOL = '1';
    await h.run(5 * MIN);
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]?.trigger).toBe('board_changed');
  });

  it('priced out by the 24-hour cap names DAILY_CAP_SOL', async () => {
    const h = harness({ env: { MAX_BID_SOL: '0.5', DAILY_CAP_SOL: '0.1' } });
    await h.run(HOUR);
    expect(h.wakes).toHaveLength(0);
    const [p] = events('priced_out');
    expect(p).toMatchObject({ limit: 'daily_cap', limit_sol: '0.1', minimum_sol: '0.101' });
    expect(p?.message).toContain('raise DAILY_CAP_SOL');
  });

  it('waiting for budget: logs the exact until and wakes at that moment', async () => {
    // Cap 0.4. Spent 0.2 at START-20h and 0.15 at START-1h → 0.35; the minimum is 0.101.
    // Dropping the 0.2 leaves 0.15 + 0.101 ≤ 0.4 → until = START-20h + 24h + 1 ms = START+4h+1ms.
    spent(START - 20 * HOUR, '0.2');
    spent(START - HOUR, '0.15');
    const h = harness({
      settings: { first_wake_max_min: 0 },
      env: { MAX_BID_SOL: '0.2', DAILY_CAP_SOL: '0.4' },
    });
    await h.run(6 * HOUR);
    const waits = events('waiting_for_budget');
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      minimum_sol: '0.101',
      spent_24h_sol: '0.35',
      daily_cap_sol: '0.4',
      until: new Date(START + 4 * HOUR + 1).toISOString(),
    });
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]?.trigger).toBe('first');
    expect(h.wakes[0]!.at).toBeGreaterThanOrEqual(START + 4 * HOUR + 1);
    expect(h.wakes[0]!.at - (START + 4 * HOUR + 1)).toBeLessThanOrEqual(1000);
  });

  it('unfunded: no wake, logged once with the shortfall; funding wakes it within the balance cache', async () => {
    const h = harness({ settings: { first_wake_max_min: 0 }, balance: 50_000_000n });
    await h.run(2 * HOUR);
    expect(h.wakes).toHaveLength(0);
    const unfunded = events('unfunded');
    expect(unfunded).toHaveLength(1);
    expect(unfunded[0]).toMatchObject({
      minimum_sol: '0.101',
      balance_sol: '0.05',
      needed_sol: '0.111',
      shortfall_sol: '0.061',
    });
    // The balance is read at most once per 5 minutes.
    const r = h.rpc.balanceReads;
    for (let i = 1; i < r.length; i++)
      expect(r[i]! - r[i - 1]!).toBeGreaterThanOrEqual(BALANCE_CACHE_MS);
    expect(r.length).toBeLessThanOrEqual((2 * HOUR) / BALANCE_CACHE_MS + 1);
    const fundedAt = h.clock.t;
    h.mock.setBalance(wallet.publicKey, SOL);
    await h.run(10 * MIN);
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]!.at - fundedAt).toBeLessThanOrEqual(BALANCE_CACHE_MS + 180_000);
  });

  it('a failed balance read never wakes on a guess: it backs off and retries', async () => {
    const h = harness({ settings: { first_wake_max_min: 0 } });
    h.rpc.failBalance = 2;
    await h.run(10 * MIN);
    expect(events('balance_error').map((e) => e.retry_in_s)).toEqual([30, 60]);
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]!.at).toBeGreaterThanOrEqual(START + 90_000);
  });

  it('re-reads the real .env every cycle: a raised limit takes effect without a restart', async () => {
    writeFileSync(paths.env, 'MAX_BID_SOL=0.2\nDAILY_CAP_SOL=0.4\nOTHER=kept\n');
    const h = harness({ env: null, amount: 300_000_000n, settings: { first_wake_max_min: 0 } });
    await h.run(HOUR);
    expect(h.wakes).toHaveLength(0);
    expect(events('priced_out')).toHaveLength(1);
    writeFileSync(paths.env, 'MAX_BID_SOL=0.35\nDAILY_CAP_SOL=0.7\nOTHER=kept\n');
    await h.run(5 * MIN);
    expect(h.wakes).toHaveLength(1);
  });

  it('an unusable limit in .env stops wakes and is logged once', async () => {
    const h = harness({ settings: { first_wake_max_min: 0 }, env: { DAILY_CAP_SOL: '0.4' } });
    await h.run(HOUR);
    expect(h.wakes).toHaveLength(0);
    expect(events('limits_invalid')).toEqual([
      expect.objectContaining({ error: 'MAX_BID_SOL is not set in .env' }),
    ]);
    expect(() => limitsFromEnv({ MAX_BID_SOL: '1e3' }, root)).toThrow(/not a SOL amount/);
    expect(() => limitsFromEnv({ MAX_BID_SOL: '0.2', DAILY_CAP_SOL: '-1' }, root)).toThrow(
      /DAILY_CAP_SOL/,
    );
    const l = limitsFromEnv({ MAX_BID_SOL: '0.2' }, root);
    expect(l).toEqual({
      maxBid: 200_000_000n,
      dailyCap: 200_000_000n,
      activityLogPath: join(root, 'billboard-activity.jsonl'),
    });
    expect(
      limitsFromEnv({ MAX_BID_SOL: '0.2', ACTIVITY_LOG_PATH: 'logs/a.jsonl' }, root)
        .activityLogPath,
    ).toBe(join(root, 'logs', 'a.jsonl'));
  });

  it('the sandbox skips the gate (its board lives in the model’s own server) and keeps state under logs/', async () => {
    const h = harness({
      sandbox: true,
      amount: 10n * SOL,
      balance: 0n,
      settings: { first_wake_max_min: 0 },
    });
    await h.run(10 * MIN);
    expect(h.wakes).toHaveLength(1);
    expect(h.rpc.balanceReads).toHaveLength(0);
    expect(events('priced_out')).toHaveLength(0);
    expect(existsSync(paths.runnerState)).toBe(false);
    expect(existsSync(statePath(paths, { sandbox: true }))).toBe(true);
    expect(runnerLog().every((e) => e.sandbox === true)).toBe(true);
  });
});

describe('dry run and the event stream', () => {
  it('a dry run logs would_wake, never calls wake, and leaves the live state alone', async () => {
    const h = harness({ dryRun: true, settings: { first_wake_max_min: 0 } });
    await h.run(10 * MIN);
    expect(h.wakes).toHaveLength(0);
    expect(events('would_wake')).toEqual([
      expect.objectContaining({ trigger: 'first', dry_run: true }),
    ]);
    expect(existsSync(paths.runnerState)).toBe(false);
    expect(state(statePath(paths, { dryRun: true })).wakes).toHaveLength(1);
    // A dry run is gated like a real one: priced out means no would_wake either.
    rmSync(paths.dir, { recursive: true, force: true });
    mkdirSync(paths.dir);
    const p = harness({ dryRun: true, amount: SOL, settings: { first_wake_max_min: 0 } });
    await p.run(10 * MIN);
    expect(events('would_wake')).toHaveLength(0);
    expect(events('priced_out')).toHaveLength(1);
  });

  it('onEvent receives every runner.log line, as written', async () => {
    const h = harness({ settings: { first_wake_max_min: 0 } });
    await h.run(10 * MIN);
    expect(h.seen).toEqual(runnerLog());
    expect(h.seen.map((e) => e.event)).toEqual([
      'started',
      'board_recorded',
      'wake_started',
      'wake_finished',
      'stopped',
    ]);
    expect(h.seen[3]).toMatchObject({
      decision: 'passed',
      reason: 'not worth it',
      next_look_hours: 6,
    });
  });

  it('MockRpc reports a balance only once set, and never below zero', async () => {
    const mock = new MockRpc();
    const key = Keypair.generate().publicKey;
    expect(await mock.getBalance(key)).toBe(0n);
    mock.setBalance(key, 5n);
    expect(await mock.getBalance(key)).toBe(5n);
    expect(() => mock.setBalance(key, -1n)).toThrow();
    expect(solToLamports('0.111')).toBe(111_000_000n);
  });
});
