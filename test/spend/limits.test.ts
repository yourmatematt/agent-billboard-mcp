import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ActivityLog } from '../../src/log/activity.js';
import { solToLamports } from '../../src/program/math.js';
import { LimitsError, SpendLimits, WINDOW_MS } from '../../src/spend/limits.js';

let dir: string;
let log: ActivityLog;
let clock: Date;
const now = () => clock;

const T0 = new Date('2026-09-14T12:00:00.000Z');
const sol = (s: string) => solToLamports(s);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-limits-'));
  clock = T0;
  log = new ActivityLog(join(dir, 'activity.jsonl'), { now });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function limits(maxBid: string, dailyCap: string = maxBid): SpendLimits {
  return new SpendLimits(
    log,
    { maxBidLamports: sol(maxBid), dailyCapLamports: sol(dailyCap) },
    { now },
  );
}

/** Append an `executed` bid at a given time without moving the test clock. */
function executedAt(ts: Date, bidSol: string) {
  log.append({
    ts: ts.toISOString(),
    event: 'executed',
    tool: 'acquire_posting_rights',
    bid_sol: bidSol,
    reasoning: 'test',
  });
}

describe('SpendLimits.checkBid', () => {
  it('allows a bid within both limits and reports the figures as SOL strings', () => {
    const check = limits('0.2', '0.5').checkBid(sol('0.101'));
    expect(check).toEqual({
      ok: true,
      bid_sol: '0.101',
      max_bid_sol: '0.2',
      daily_cap_sol: '0.5',
      spent_last_24h_sol: '0',
      remaining_today_sol: '0.5',
    });
  });

  it('refuses a bid over MAX_BID_SOL even when the daily cap has room', () => {
    const check = limits('0.2', '10').checkBid(sol('0.200000001'));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe('max_bid');
    expect(check.bid_sol).toBe('0.200000001');
    expect(check.max_bid_sol).toBe('0.2');
    expect(check.message).toContain('MAX_BID_SOL');
  });

  it('allows a bid exactly at MAX_BID_SOL', () => {
    expect(limits('0.2', '10').checkBid(sol('0.2')).ok).toBe(true);
  });

  it('counts executed bids in the last 24 h and refuses when the cap would be exceeded', () => {
    executedAt(new Date(T0.getTime() - 3_600_000), '0.3');
    const l = limits('0.5', '0.5');
    const check = l.checkBid(sol('0.201'));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe('daily_cap');
    expect(check.spent_last_24h_sol).toBe('0.3');
    expect(check.remaining_today_sol).toBe('0.2');
    expect(check.message).toContain('DAILY_CAP_SOL');
  });

  it('allows a bid that lands exactly on the daily cap, then refuses anything more', () => {
    executedAt(new Date(T0.getTime() - 3_600_000), '0.3');
    const l = limits('0.5', '0.5');
    expect(l.checkBid(sol('0.2')).ok).toBe(true);

    executedAt(T0, '0.2');
    expect(l.spentLast24h()).toBe(sol('0.5'));
    expect(l.remainingToday()).toBe(0n);
    const check = l.checkBid(1n);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe('daily_cap');
    expect(check.remaining_today_sol).toBe('0');
  });

  it('applies MAX_BID before the daily cap when both are breached', () => {
    executedAt(T0, '0.5');
    const check = limits('0.1', '0.5').checkBid(sol('0.2'));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe('max_bid');
  });

  it('rolling window: an entry exactly 24 h old still counts, one millisecond older does not', () => {
    executedAt(new Date(T0.getTime() - WINDOW_MS), '0.3');
    const l = limits('0.5', '0.5');
    expect(l.spentLast24h()).toBe(sol('0.3'));
    expect(l.checkBid(sol('0.3')).ok).toBe(false);

    clock = new Date(T0.getTime() + 1);
    expect(l.spentLast24h()).toBe(0n);
    expect(l.checkBid(sol('0.3')).ok).toBe(true);
  });

  it('rolling window: allowance comes back as old entries age out, not at midnight', () => {
    executedAt(new Date(T0.getTime() - 20 * 3_600_000), '0.2');
    executedAt(new Date(T0.getTime() - 2 * 3_600_000), '0.2');
    const l = limits('0.5', '0.5');
    expect(l.spentLast24h()).toBe(sol('0.4'));
    expect(l.checkBid(sol('0.2')).ok).toBe(false);

    clock = new Date(T0.getTime() + 5 * 3_600_000); // first entry is now 25 h old
    expect(l.spentLast24h()).toBe(sol('0.2'));
    expect(l.checkBid(sol('0.2')).ok).toBe(true);
    expect(l.checkBid(sol('0.3')).ok).toBe(true);
    expect(l.checkBid(sol('0.300000001')).ok).toBe(false);
  });

  it('only executed entries with a bid count as spend', () => {
    const t = T0;
    log.append({
      ts: t.toISOString(),
      event: 'proposed',
      tool: 'a',
      bid_sol: '0.4',
      reasoning: 'r',
    });
    log.append({
      ts: t.toISOString(),
      event: 'approved',
      tool: 'a',
      bid_sol: '0.4',
      reasoning: 'r',
    });
    log.append({
      ts: t.toISOString(),
      event: 'refused_limit',
      tool: 'a',
      bid_sol: '9',
      reasoning: 'r',
    });
    log.append({ ts: t.toISOString(), event: 'failed', tool: 'a', bid_sol: '0.4', error: 'x' });
    log.append({ ts: t.toISOString(), event: 'expired', tool: 'a', bid_sol: '0.4' });
    log.append({ ts: t.toISOString(), event: 'outbid_detected', tool: 'reader' });
    log.append({ ts: t.toISOString(), event: 'refused_not_poster', tool: 'append_message' });
    // An executed append or clear carries no bid and is not spend.
    log.append({ ts: t.toISOString(), event: 'executed', tool: 'append_message', tx: 'sig' });
    const l = limits('0.5', '0.5');
    expect(l.spentLast24h()).toBe(0n);
    expect(l.checkBid(sol('0.5')).ok).toBe(true);

    executedAt(t, '0.1');
    expect(l.spentLast24h()).toBe(sol('0.1'));
  });

  it('sums many small executed bids exactly (no float drift)', () => {
    for (let i = 0; i < 10; i++) executedAt(T0, '0.1');
    const l = limits('1', '1');
    expect(l.spentLast24h()).toBe(sol('1'));
    expect(l.checkBid(1n).ok).toBe(false);
    expect(l.summary().spent_last_24h_sol).toBe('1');
  });

  it('never reports negative remaining when the cap was lowered below what is already spent', () => {
    executedAt(T0, '0.8');
    const l = limits('0.5', '0.5');
    expect(l.remainingToday()).toBe(0n);
    expect(l.summary().remaining_today_sol).toBe('0');
    const check = l.checkBid(1n);
    expect(check.ok).toBe(false);
    expect(check.remaining_today_sol).toBe('0');
  });

  it('reads the log fresh on every check, so a restart cannot reset the allowance', () => {
    const l = limits('0.5', '0.5');
    expect(l.checkBid(sol('0.5')).ok).toBe(true);
    // Another writer (or a previous process) appends to the same file.
    const other = new ActivityLog(log.path, { now });
    other.append({
      event: 'executed',
      tool: 'acquire_posting_rights',
      bid_sol: '0.5',
      reasoning: 'r',
    });
    expect(l.checkBid(1n).ok).toBe(false);
  });

  it('rejects non-bigint or negative inputs', () => {
    const l = limits('0.5');
    expect(() => l.checkBid(0.1 as never)).toThrow(LimitsError);
    expect(() => l.checkBid(-1n)).toThrow(LimitsError);
    expect(
      () => new SpendLimits(log, { maxBidLamports: -1n, dailyCapLamports: 1n }, { now }),
    ).toThrow(LimitsError);
  });

  it('daily cap below max bid is honoured as the binding limit', () => {
    const l = limits('1', '0.3');
    const check = l.checkBid(sol('0.5'));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toBe('daily_cap');
  });
});

describe('SpendLimits.summary', () => {
  it('returns the four figures read_billboard needs', () => {
    executedAt(new Date(T0.getTime() - 1000), '0.15');
    expect(limits('0.2', '0.5').summary()).toEqual({
      max_bid_sol: '0.2',
      daily_cap_sol: '0.5',
      spent_last_24h_sol: '0.15',
      remaining_today_sol: '0.35',
    });
  });
});
