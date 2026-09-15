import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ActivityLog } from '../src/log/activity.js';
import type { BillboardState } from '../src/program/layout.js';
import { solToLamports } from '../src/program/math.js';
import {
  PROPOSAL_RETENTION_MS,
  PROPOSAL_TTL_MS,
  ProposalError,
  ProposalStore,
  proposalBidSol,
  type ProposalAction,
} from '../src/proposals.js';
import { planAcquire } from '../src/tools/acquire_posting_rights.js';
import { planAppend } from '../src/tools/append_message.js';

const T0 = new Date('2026-09-14T12:00:00.000Z');
const them = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;

function state(overrides: Partial<BillboardState> = {}): BillboardState {
  const message = overrides.message ?? 'theirs';
  return {
    creator,
    poster: them,
    amount: solToLamports('0.1'),
    message,
    messageBytes: Buffer.byteLength(message, 'utf8'),
    ...overrides,
  };
}

function acquireAction(before: BillboardState, bid = '0.101'): ProposalAction {
  const planned = planAcquire(before, { bid_sol: bid, message: 'hi' });
  if (!planned.ok) throw new Error(planned.reason);
  return { kind: 'acquire', plan: planned.plan };
}

function appendAction(before: BillboardState): ProposalAction {
  const planned = planAppend(before, 'more', true);
  if (!planned.ok) throw new Error(planned.reason);
  return { kind: 'append', plan: planned.plan };
}

let dir: string;
let clock: Date;
let log: ActivityLog;
let warnings: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-proposals-'));
  clock = T0;
  warnings = [];
  log = new ActivityLog(join(dir, 'activity.jsonl'), {
    now: () => clock,
    warn: (m) => warnings.push(m),
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store(ttlMs?: number): ProposalStore {
  return new ProposalStore({
    activityLog: log,
    now: () => clock,
    warn: (m) => warnings.push(m),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
}

const REASON = 'Worth 0.101 SOL to us this week.';

describe('ProposalStore.create', () => {
  it('stores a pending proposal with a 10-minute deadline and logs `proposed`', () => {
    const s = store();
    const before = state();
    const p = s.create({
      tool: 'acquire_posting_rights',
      action: acquireAction(before),
      reasoning: REASON,
      before,
    });

    expect(p.id).toMatch(/^prop_[0-9a-f]{12}$/);
    expect(p.createdAt).toEqual(T0);
    expect(p.expiresAt.getTime() - p.createdAt.getTime()).toBe(PROPOSAL_TTL_MS);
    expect(PROPOSAL_TTL_MS).toBe(10 * 60 * 1000);
    expect(s.lookup(p.id)).toEqual({ status: 'pending', proposal: p });
    expect(s.pendingCount).toBe(1);

    const entries = log.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ts: T0.toISOString(),
      event: 'proposed',
      tool: 'acquire_posting_rights',
      reasoning: REASON,
      proposal_id: p.id,
      bid_sol: '0.101',
      billboard_before: { poster: them.toBase58(), amount_sol: '0.1' },
    });
  });

  it('omits bid_sol for append and clear proposals', () => {
    const s = store();
    const before = state();
    const a = s.create({
      tool: 'append_message',
      action: appendAction(before),
      reasoning: REASON,
      before,
    });
    const c = s.create({
      tool: 'clear_message',
      action: { kind: 'clear' },
      reasoning: REASON,
      before,
    });
    expect(proposalBidSol(a.action)).toBeUndefined();
    expect(proposalBidSol(c.action)).toBeUndefined();
    for (const entry of log.entries()) expect(entry.bid_sol).toBeUndefined();
    expect(log.entries().map((e) => e.tool)).toEqual(['append_message', 'clear_message']);
  });

  it('generates distinct ids', () => {
    const s = store();
    const before = state();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      ids.add(
        s.create({ tool: 'clear_message', action: { kind: 'clear' }, reasoning: REASON, before })
          .id,
      );
    }
    expect(ids.size).toBe(50);
  });

  it('refuses a blank reasoning and an invalid ttl', () => {
    const before = state();
    expect(() =>
      store().create({ tool: 'clear_message', action: { kind: 'clear' }, reasoning: '  ', before }),
    ).toThrow(ProposalError);
    expect(() => store(0)).toThrow(ProposalError);
    expect(() => store(1.5)).toThrow(ProposalError);
  });
});

describe('ProposalStore.lookup', () => {
  it('returns unknown for an id it never issued', () => {
    expect(store().lookup('prop_000000000000')).toEqual({ status: 'unknown' });
    expect(store().lookup('')).toEqual({ status: 'unknown' });
  });
});

describe('expiry', () => {
  it('is pending until the deadline, expired at it, and logs `expired` exactly once', () => {
    const s = store();
    const before = state();
    const p = s.create({
      tool: 'acquire_posting_rights',
      action: acquireAction(before),
      reasoning: REASON,
      before,
    });

    clock = new Date(T0.getTime() + PROPOSAL_TTL_MS - 1);
    expect(s.lookup(p.id).status).toBe('pending');
    expect(s.sweep()).toEqual([]);

    clock = new Date(T0.getTime() + PROPOSAL_TTL_MS);
    const swept = s.sweep();
    expect(swept.map((x) => x.id)).toEqual([p.id]);
    expect(s.lookup(p.id)).toEqual({ status: 'expired', proposal: p, settledAt: clock });
    expect(s.pendingCount).toBe(0);
    expect(s.sweep()).toEqual([]);

    const entries = log.entries();
    expect(entries.map((e) => e.event)).toEqual(['proposed', 'expired']);
    expect(entries[1]).toMatchObject({
      ts: clock.toISOString(),
      tool: 'acquire_posting_rights',
      reasoning: REASON,
      proposal_id: p.id,
      bid_sol: '0.101',
    });
  });

  it('expires on lookup, not only on an explicit sweep', () => {
    const s = store(1000);
    const before = state();
    const p = s.create({
      tool: 'clear_message',
      action: { kind: 'clear' },
      reasoning: REASON,
      before,
    });
    clock = new Date(T0.getTime() + 1000);
    expect(s.lookup(p.id).status).toBe('expired');
    expect(log.entries().map((e) => e.event)).toEqual(['proposed', 'expired']);
  });

  it('cannot approve or settle an expired proposal', () => {
    const s = store(1000);
    const before = state();
    const p = s.create({
      tool: 'clear_message',
      action: { kind: 'clear' },
      reasoning: REASON,
      before,
    });
    clock = new Date(T0.getTime() + 1000);
    expect(() => s.approve(p.id, before)).toThrow(/already expired/);
    expect(() => s.settle(p.id, 'stale')).toThrow(/already expired/);
  });

  it('forgets settled records after the retention window but keeps them before it', () => {
    const s = store(1000);
    const before = state();
    const p = s.create({
      tool: 'clear_message',
      action: { kind: 'clear' },
      reasoning: REASON,
      before,
    });
    clock = new Date(T0.getTime() + 1000);
    s.sweep();
    clock = new Date(T0.getTime() + 1000 + PROPOSAL_RETENTION_MS);
    expect(s.lookup(p.id).status).toBe('expired');
    clock = new Date(T0.getTime() + 1000 + PROPOSAL_RETENTION_MS + 1);
    expect(s.lookup(p.id).status).toBe('unknown');
  });

  it('the timer sweeper does not keep the process alive and can be stopped', () => {
    const s = store();
    s.startSweeper(50);
    s.startSweeper(50);
    s.stopSweeper();
    s.stopSweeper();
  });
});

describe('approve and settle', () => {
  it('approve logs `approved` with the billboard as re-read and consumes the proposal', () => {
    const s = store();
    const before = state();
    const p = s.create({
      tool: 'acquire_posting_rights',
      action: acquireAction(before),
      reasoning: REASON,
      before,
    });
    clock = new Date(T0.getTime() + 5000);
    const now = state({ message: 'theirs, edited' });
    expect(s.approve(p.id, now)).toBe(p);
    expect(s.lookup(p.id)).toEqual({ status: 'approved', proposal: p, settledAt: clock });
    expect(() => s.approve(p.id, now)).toThrow(/already approved/);
    expect(() => s.settle(p.id, 'stale')).toThrow(/already approved/);

    const entries = log.entries();
    expect(entries.map((e) => e.event)).toEqual(['proposed', 'approved']);
    expect(entries[1]).toMatchObject({
      ts: clock.toISOString(),
      tool: 'approve_proposal',
      reasoning: REASON,
      proposal_id: p.id,
      bid_sol: '0.101',
      billboard_before: { poster: them.toBase58(), amount_sol: '0.1' },
    });
  });

  it('settle marks stale or refused without logging and blocks a later approve', () => {
    const s = store();
    const before = state();
    const a = s.create({
      tool: 'clear_message',
      action: { kind: 'clear' },
      reasoning: REASON,
      before,
    });
    const b = s.create({
      tool: 'clear_message',
      action: { kind: 'clear' },
      reasoning: REASON,
      before,
    });
    s.settle(a.id, 'stale');
    s.settle(b.id, 'refused');
    expect(s.lookup(a.id).status).toBe('stale');
    expect(s.lookup(b.id).status).toBe('refused');
    expect(() => s.approve(a.id, before)).toThrow(/already stale/);
    expect(log.entries().map((e) => e.event)).toEqual(['proposed', 'proposed']);
    expect(s.pendingCount).toBe(0);
  });

  it('approve and settle reject unknown ids', () => {
    const s = store();
    expect(() => s.approve('prop_nope', state())).toThrow(/unknown proposal/);
    expect(() => s.settle('prop_nope', 'stale')).toThrow(/unknown proposal/);
  });

  it('never writes anything but the schema fields (no plan, no state) to the log', () => {
    const s = store();
    const before = state({ poster: new PublicKey(them) });
    s.create({
      tool: 'acquire_posting_rights',
      action: acquireAction(before),
      reasoning: REASON,
      before,
    });
    const raw = JSON.stringify(log.read());
    expect(raw).not.toMatch(/plan|chunks|creator|"message"/);
    expect(warnings).toEqual([]);
  });
});
