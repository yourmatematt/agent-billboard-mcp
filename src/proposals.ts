/**
 * In-memory proposal store for `AUTO_BID=false`.
 *
 * In propose mode the three write tools do everything except sign: they
 * read the billboard, plan the transaction(s), check the spend limits, and
 * then park the plan here as a proposal. Nothing is signed until
 * `approve_proposal` is called with the proposal's id, and that call is
 * the one an MCP client puts a per-tool permission prompt on. The server
 * cannot see the human; it only sees the tool call.
 *
 * Lifecycle of a record:
 *
 *   pending ──approve()──▶ approved      (then the plan is executed)
 *   pending ──sweep()────▶ expired       (PROPOSAL_TTL_MIN minutes after
 *                                         creation, logged)
 *   pending ──create()───▶ superseded    (the same tool proposed again;
 *                                         logged with both ids)
 *   pending ──settle()───▶ stale|refused (approve_proposal found the board
 *                                         moved, or the limits no longer
 *                                         allow the bid)
 *
 * A tool has at most one open proposal at a time. An agent woken on a
 * schedule re-reads the board and proposes again before anyone answered
 * the last one; without this rule the owner would be looking at a list of
 * near-identical proposals and could approve a bid computed against a
 * board state two wakes old. The newest proposal for a tool is the only
 * one that can be approved; the one it replaced says which id took over.
 *
 * Settled records are kept (for `PROPOSAL_RETENTION_MS`) so a second
 * approval of the same id gets a precise answer instead of "unknown", and
 * so a proposal can never execute twice.
 *
 * The store logs `proposed` when a proposal is created, `superseded` when
 * creating one replaces an open proposal from the same tool, `expired`
 * when a sweep finds one past its deadline, and `approved` from
 * `approve()`. The `executed` / `failed` entries come from the execute helpers of the
 * originating tools, stamped with the same `proposal_id`.
 *
 * Nothing here writes to stdout.
 */
import { randomBytes } from 'node:crypto';

import { snapshot } from './billboard/reader.js';
import type { ActivityLog } from './log/activity.js';
import type { BillboardState } from './program/layout.js';
import { lamportsToSol } from './program/math.js';
import type { AcquirePlan } from './tools/acquire_posting_rights.js';
import type { AppendPlan } from './tools/append_message.js';

/**
 * Default proposal lifetime in minutes (`PROPOSAL_TTL_MIN`). An hour is
 * long enough for an agent on a heartbeat to relay a proposal to its owner
 * on Telegram or Slack and get an answer back, and short enough that the
 * board has usually not moved underneath it.
 */
export const DEFAULT_PROPOSAL_TTL_MIN = 60;

/** Accepted range for `PROPOSAL_TTL_MIN`: one minute to one day. */
export const MIN_PROPOSAL_TTL_MIN = 1;
export const MAX_PROPOSAL_TTL_MIN = 1440;

/** Proposals expire this long after creation unless `PROPOSAL_TTL_MIN` says otherwise. */
export const PROPOSAL_TTL_MS = DEFAULT_PROPOSAL_TTL_MIN * 60 * 1000;

/** Settled records are forgotten this long after they settle. */
export const PROPOSAL_RETENTION_MS = 24 * 60 * 60 * 1000;

export const PROPOSAL_ID_PREFIX = 'prop_';

export type ProposalKind = 'acquire' | 'append' | 'clear';

/** What the proposal would do, carrying the plan computed at proposal time. */
export type ProposalAction =
  { kind: 'acquire'; plan: AcquirePlan } | { kind: 'append'; plan: AppendPlan } | { kind: 'clear' };

export interface Proposal {
  readonly id: string;
  /** Originating tool: `acquire_posting_rights`, `append_message` or `clear_message`. */
  readonly tool: string;
  readonly action: ProposalAction;
  readonly reasoning: string;
  /** The billboard as read when the proposal was made. Approval compares against it. */
  readonly before: BillboardState;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type SettledStatus = 'approved' | 'expired' | 'stale' | 'refused' | 'superseded';
export type ProposalStatus = 'pending' | SettledStatus;

export type ProposalLookup =
  | { status: 'unknown' }
  | { status: 'pending'; proposal: Proposal }
  | { status: 'superseded'; proposal: Proposal; settledAt: Date; supersededBy: string }
  | { status: Exclude<SettledStatus, 'superseded'>; proposal: Proposal; settledAt: Date };

interface Record_ {
  proposal: Proposal;
  status: ProposalStatus;
  settledAt: Date | null;
  /** Id of the proposal that replaced this one. Only set when `superseded`. */
  supersededBy: string | null;
}

export class ProposalError extends Error {
  override readonly name = 'ProposalError';
  constructor(message: string) {
    super(message);
  }
}

export interface ProposalStoreOptions {
  activityLog: ActivityLog;
  /** Clock. Injectable for tests. Default `() => new Date()`. */
  now?: () => Date;
  /** Default `PROPOSAL_TTL_MS`. Set from `PROPOSAL_TTL_MIN` in production. */
  ttlMs?: number;
  /** Where warnings go. Default: stderr. */
  warn?: (message: string) => void;
}

export interface CreateProposalInput {
  tool: string;
  action: ProposalAction;
  reasoning: string;
  before: BillboardState;
}

/** The gross bid a proposal would spend, as a SOL string; undefined for append/clear. */
export function proposalBidSol(action: ProposalAction): string | undefined {
  return action.kind === 'acquire' ? lamportsToSol(action.plan.bid) : undefined;
}

export class ProposalStore {
  readonly ttlMs: number;
  private readonly records = new Map<string, Record_>();
  private readonly activityLog: ActivityLog;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(options: ProposalStoreOptions) {
    this.activityLog = options.activityLog;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? PROPOSAL_TTL_MS;
    this.warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
    if (!Number.isInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new ProposalError(`proposal ttlMs must be a positive integer, got ${this.ttlMs}`);
    }
  }

  /** Number of pending proposals (after a sweep). */
  get pendingCount(): number {
    this.sweep();
    let n = 0;
    for (const record of this.records.values()) if (record.status === 'pending') n += 1;
    return n;
  }

  /**
   * Stores a new pending proposal and logs `proposed`. The log entry is
   * written before the proposal becomes visible, so a proposal that exists
   * always has its `proposed` line.
   *
   * If the same tool already has an open proposal, that one is marked
   * `superseded` first and logged with both ids, so the log reads in order:
   * `superseded` (the old id, naming its replacement), then `proposed` (the
   * new one). Only the new proposal can be approved.
   */
  create(input: CreateProposalInput): Proposal {
    this.sweep();
    if (input.reasoning.trim() === '') {
      throw new ProposalError('a proposal needs a non-empty reasoning');
    }
    const createdAt = this.now();
    const proposal: Proposal = {
      id: newProposalId(),
      tool: input.tool,
      action: input.action,
      reasoning: input.reasoning,
      before: input.before,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.ttlMs),
    };
    this.supersedeOpen(input.tool, proposal.id, createdAt);
    const bidSol = proposalBidSol(proposal.action);
    this.activityLog.append({
      event: 'proposed',
      tool: proposal.tool,
      reasoning: proposal.reasoning,
      proposal_id: proposal.id,
      ...(bidSol === undefined ? {} : { bid_sol: bidSol }),
      billboard_before: snapshot(proposal.before),
    });
    this.records.set(proposal.id, {
      proposal,
      status: 'pending',
      settledAt: null,
      supersededBy: null,
    });
    return proposal;
  }

  /** The open proposal for a tool, if it has one. At most one can exist. */
  openFor(tool: string): Proposal | null {
    this.sweep();
    for (const record of this.records.values()) {
      if (record.status === 'pending' && record.proposal.tool === tool) return record.proposal;
    }
    return null;
  }

  /** Finds a proposal by id, after expiring anything past its deadline. */
  lookup(id: string): ProposalLookup {
    this.sweep();
    const record = this.records.get(id);
    if (record === undefined) return { status: 'unknown' };
    if (record.status === 'pending') return { status: 'pending', proposal: record.proposal };
    const settledAt = record.settledAt ?? record.proposal.expiresAt;
    if (record.status === 'superseded') {
      return {
        status: 'superseded',
        proposal: record.proposal,
        settledAt,
        // A superseded record always carries the replacement; the fallback
        // keeps the type honest rather than describing a state that happens.
        supersededBy: record.supersededBy ?? '(unknown)',
      };
    }
    return { status: record.status, proposal: record.proposal, settledAt };
  }

  /**
   * Marks a pending proposal approved and logs `approved` with the
   * billboard as re-read at approval time. Throws if the proposal is not
   * pending: the caller must `lookup` first, and a proposal can only be
   * approved once.
   */
  approve(id: string, billboardNow: BillboardState): Proposal {
    const record = this.requirePending(id, 'approve');
    const bidSol = proposalBidSol(record.proposal.action);
    this.activityLog.append({
      event: 'approved',
      tool: APPROVE_LOG_TOOL,
      reasoning: record.proposal.reasoning,
      proposal_id: id,
      ...(bidSol === undefined ? {} : { bid_sol: bidSol }),
      billboard_before: snapshot(billboardNow),
    });
    record.status = 'approved';
    record.settledAt = this.now();
    return record.proposal;
  }

  /**
   * Marks a pending proposal stale or refused. Not logged here: a stale
   * proposal has no event type of its own, and a limit refusal is logged
   * as `refused_limit` by the caller with the figures.
   */
  settle(id: string, status: 'stale' | 'refused'): Proposal {
    const record = this.requirePending(id, status);
    record.status = status;
    record.settledAt = this.now();
    return record.proposal;
  }

  /**
   * Expires every pending proposal past its deadline (logging `expired`
   * for each) and forgets settled records older than the retention window.
   * Returns the proposals expired by this call. Safe to call often; every
   * other method calls it first.
   */
  sweep(): Proposal[] {
    const now = this.now();
    const nowMs = now.getTime();
    const expired: Proposal[] = [];
    for (const [id, record] of this.records) {
      if (record.status === 'pending' && record.proposal.expiresAt.getTime() <= nowMs) {
        record.status = 'expired';
        record.settledAt = now;
        expired.push(record.proposal);
        this.logExpired(record.proposal);
      } else if (
        record.status !== 'pending' &&
        record.settledAt !== null &&
        nowMs - record.settledAt.getTime() > PROPOSAL_RETENTION_MS
      ) {
        this.records.delete(id);
      }
    }
    return expired;
  }

  /**
   * Runs `sweep()` on a timer so an abandoned proposal gets its `expired`
   * line even if no tool is called again. The timer is unref'd and never
   * keeps the process alive. Idempotent.
   */
  startSweeper(intervalMs = 60_000): void {
    if (this.sweeper !== null) return;
    this.sweeper = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.warn(`proposal sweep failed (${message})`);
      }
    }, intervalMs);
    this.sweeper.unref();
  }

  stopSweeper(): void {
    if (this.sweeper === null) return;
    clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private requirePending(id: string, verb: string): Record_ {
    this.sweep();
    const record = this.records.get(id);
    if (record === undefined) {
      throw new ProposalError(`cannot ${verb} unknown proposal ${id}`);
    }
    if (record.status !== 'pending') {
      throw new ProposalError(`cannot ${verb} proposal ${id}: it is already ${record.status}`);
    }
    return record;
  }

  /**
   * Marks the open proposal for `tool` (if any) superseded by `replacementId`
   * and logs it. Called from `create` before the replacement is stored, so
   * the two proposals are never both pending.
   */
  private supersedeOpen(tool: string, replacementId: string, at: Date): void {
    for (const record of this.records.values()) {
      if (record.status !== 'pending' || record.proposal.tool !== tool) continue;
      record.status = 'superseded';
      record.settledAt = at;
      record.supersededBy = replacementId;
      this.logSuperseded(record.proposal, replacementId);
      // At most one proposal per tool is ever pending, so there is nothing
      // left to find; stop rather than walk the rest of the store.
      return;
    }
  }

  private logSuperseded(proposal: Proposal, replacementId: string): void {
    const bidSol = proposalBidSol(proposal.action);
    try {
      this.activityLog.append({
        event: 'superseded',
        tool: proposal.tool,
        reasoning: proposal.reasoning,
        proposal_id: proposal.id,
        superseded_by: replacementId,
        ...(bidSol === undefined ? {} : { bid_sol: bidSol }),
        billboard_before: snapshot(proposal.before),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(`could not log supersession of proposal ${proposal.id} (${message})`);
    }
  }

  private logExpired(proposal: Proposal): void {
    const bidSol = proposalBidSol(proposal.action);
    try {
      this.activityLog.append({
        event: 'expired',
        tool: proposal.tool,
        reasoning: proposal.reasoning,
        proposal_id: proposal.id,
        ...(bidSol === undefined ? {} : { bid_sol: bidSol }),
        billboard_before: snapshot(proposal.before),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(`could not log expiry of proposal ${proposal.id} (${message})`);
    }
  }
}

/** Tool name recorded on `approved` entries. Mirrors `APPROVE_TOOL` in the tool file. */
export const APPROVE_LOG_TOOL = 'approve_proposal';

function newProposalId(): string {
  return `${PROPOSAL_ID_PREFIX}${randomBytes(6).toString('hex')}`;
}
