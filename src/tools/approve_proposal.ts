/**
 * `approve_proposal`: sign a proposal made under `AUTO_BID=false`.
 *
 * This is the one tool an MCP client should gate with a permission prompt
 * in propose mode. The server cannot see the human; it only sees this call.
 * So it does not trust the proposal blindly either:
 *
 *   1. look the proposal up            (refused: unknown_proposal, expired,
 *                                        superseded, already_approved,
 *                                        already_settled; nothing logged
 *                                        except `expired`, which the store
 *                                        writes on sweep, and `superseded`,
 *                                        written when the replacement was
 *                                        made)
 *   2. re-read the billboard           (throws -> isError text)
 *   3. compare with the proposal's     (refused: stale, when poster, amount
 *      `before` state                   or message changed; the proposal is
 *                                        consumed, nothing signed)
 *   4. re-plan against the fresh read  (refused with the plan's own code if
 *                                        anything no longer fits; cannot
 *                                        happen when 3 passed, kept as a
 *                                        guard because it is cheap)
 *   5. re-check the spend limits       (acquire only; refused: limit_exceeded,
 *                                        logged as `refused_limit` with the
 *                                        proposal_id)
 *   6. log `approved`, then execute    (`executed` / `failed` entries carry
 *                                        the originating tool's name and the
 *                                        proposal_id)
 *
 * A proposal can be approved once. A second call gets `already_approved`
 * and sends nothing.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { snapshot, statesEqual } from '../billboard/reader.js';
import type { BillboardState } from '../program/layout.js';
import { lamportsToSol } from '../program/math.js';
import {
  APPROVE_LOG_TOOL,
  type Proposal,
  type ProposalKind,
  type ProposalLookup,
} from '../proposals.js';
import type { ServerContext } from '../server.js';
import {
  executeAcquire,
  limitsFromCheck,
  planAcquire,
  type AcquireOutput,
} from './acquire_posting_rights.js';
import { executeAppend, planAppend } from './append_message.js';
import { executeClear, planClear } from './clear_message.js';
import { READ_ONLY_TEXT, afterFigures, billboardAfterShape, solString } from './shared.js';

export const APPROVE_TOOL = APPROVE_LOG_TOOL;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const approveInputShape = {
  proposal_id: z
    .string()
    .min(1, 'proposal_id must not be empty')
    .describe(
      'The proposal_id returned by acquire_posting_rights, append_message or clear_message.',
    ),
};

const approveInputSchema = z.object(approveInputShape);
export type ApproveInput = z.infer<typeof approveInputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const APPROVE_STATUSES = ['refused', 'executed', 'failed'] as const;
export type ApproveStatus = (typeof APPROVE_STATUSES)[number];

export const APPROVE_ERRORS = [
  'unknown_proposal',
  'expired',
  'superseded',
  'already_approved',
  'already_settled',
  'stale',
  'limit_exceeded',
  'invalid_bid',
  'below_minimum',
  'message_too_long',
  'not_poster',
  'already_empty',
  'transaction_failed',
] as const;
export type ApproveErrorCode = (typeof APPROVE_ERRORS)[number];

const boardShape = z.object({
  poster: z.string(),
  amount_sol: solString,
  message_bytes: z.number().int().min(0),
});

export const approveOutputShape = {
  status: z.enum(APPROVE_STATUSES),
  error: z.enum(APPROVE_ERRORS).optional(),
  reason: z.string().optional().describe('Human-readable detail for refused and failed outcomes.'),
  proposal_id: z.string(),
  superseded_by: z
    .string()
    .optional()
    .describe('On error `superseded`: the id of the newer proposal to approve instead.'),
  kind: z.enum(['acquire', 'append', 'clear']).optional(),
  tool: z.string().optional().describe('The tool that made the proposal.'),
  reasoning: z.string().optional().describe('The reasoning given when the proposal was made.'),
  proposed_at: z.iso.datetime().optional(),
  expires_at: z.iso.datetime().optional(),
  bid_sol: solString.optional().describe('Gross bid for an acquire proposal.'),
  billboard_at_proposal: boardShape.optional(),
  billboard_now: boardShape.optional().describe('The billboard as re-read by this call.'),
  limits: z
    .object({
      ok: z.boolean(),
      reason: z.enum(['max_bid', 'daily_cap']).optional(),
      max_bid_sol: solString,
      daily_cap_sol: solString,
      spent_last_24h_sol: solString,
      remaining_today_sol: solString,
    })
    .nullable()
    .optional()
    .describe('Spend-limit re-check at approval time (acquire proposals only).'),
  transactions_planned: z.number().int().min(0),
  transactions_sent: z.number().int().min(0),
  signatures: z.array(z.string()),
  billboard_after: billboardAfterShape.optional(),
};

const approveOutputSchema = z.object(approveOutputShape);
export type ApproveOutput = z.infer<typeof approveOutputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function board(state: BillboardState): z.infer<typeof boardShape> {
  return {
    poster: state.poster.toBase58(),
    amount_sol: lamportsToSol(state.amount),
    message_bytes: state.messageBytes,
  };
}

function describeProposal(
  proposal: Proposal,
): Pick<
  ApproveOutput,
  | 'proposal_id'
  | 'kind'
  | 'tool'
  | 'reasoning'
  | 'proposed_at'
  | 'expires_at'
  | 'bid_sol'
  | 'billboard_at_proposal'
> {
  const kind: ProposalKind = proposal.action.kind;
  return {
    proposal_id: proposal.id,
    kind,
    tool: proposal.tool,
    reasoning: proposal.reasoning,
    proposed_at: proposal.createdAt.toISOString(),
    expires_at: proposal.expiresAt.toISOString(),
    ...(proposal.action.kind === 'acquire'
      ? { bid_sol: lamportsToSol(proposal.action.plan.bid) }
      : {}),
    billboard_at_proposal: board(proposal.before),
  };
}

const EMPTY_EXECUTION = {
  transactions_planned: 0,
  transactions_sent: 0,
  signatures: [] as string[],
};

/** What changed between the proposal's read and now, for the `stale` reason. */
export function describeChange(before: BillboardState, now: BillboardState): string {
  const changes: string[] = [];
  if (!before.poster.equals(now.poster)) {
    changes.push(`poster ${before.poster.toBase58()} -> ${now.poster.toBase58()}`);
  }
  if (before.amount !== now.amount) {
    changes.push(`amount ${lamportsToSol(before.amount)} -> ${lamportsToSol(now.amount)} SOL`);
  }
  if (before.messageBytes !== now.messageBytes || before.message !== now.message) {
    changes.push(`message ${before.messageBytes} -> ${now.messageBytes} bytes`);
  }
  if (!before.creator.equals(now.creator)) {
    changes.push('creator changed');
  }
  return changes.join(', ');
}

function lookupRefusal(
  lookup: ProposalLookup,
  proposalId: string,
  ttlMinutes: number,
): {
  error: ApproveErrorCode;
  reason: string;
  proposal: Proposal | null;
  supersededBy?: string;
} | null {
  switch (lookup.status) {
    case 'pending':
      return null;
    case 'unknown':
      return {
        error: 'unknown_proposal',
        reason:
          `no proposal ${proposalId} is known to this server. Proposals live in memory for ` +
          `${ttlMinutes} minute${ttlMinutes === 1 ? '' : 's'}; ` +
          'make a new one with acquire_posting_rights, append_message or clear_message.',
        proposal: null,
      };
    case 'expired':
      return {
        error: 'expired',
        reason: `proposal ${proposalId} expired at ${lookup.proposal.expiresAt.toISOString()}; make a new one.`,
        proposal: lookup.proposal,
      };
    case 'superseded':
      return {
        error: 'superseded',
        reason:
          `proposal ${proposalId} was replaced at ${lookup.settledAt.toISOString()} by proposal ` +
          `${lookup.supersededBy}, which ${lookup.proposal.tool} made against a later read of the ` +
          'billboard. Nothing was signed. Approve that proposal instead if the owner said yes to it.',
        proposal: lookup.proposal,
        supersededBy: lookup.supersededBy,
      };
    case 'approved':
      return {
        error: 'already_approved',
        reason:
          `proposal ${proposalId} was already approved at ${lookup.settledAt.toISOString()}; ` +
          'nothing was sent again. The activity log has its transactions.',
        proposal: lookup.proposal,
      };
    case 'stale':
    case 'refused':
      return {
        error: 'already_settled',
        reason: `proposal ${proposalId} was already ${lookup.status} at ${lookup.settledAt.toISOString()}; make a new one.`,
        proposal: lookup.proposal,
      };
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

/**
 * Runs the tool end to end and returns the structured output, or a plain
 * string for the one outcome that has no proposal to describe (read-only
 * mode, where proposals cannot exist).
 */
export async function approveProposal(
  context: ServerContext,
  input: ApproveInput,
): Promise<ApproveOutput | { text: string }> {
  const { config, limits, activityLog, proposals, reader } = context;
  const proposalId = input.proposal_id;

  if (config.readOnly || config.keypair === null) {
    return { text: READ_ONLY_TEXT };
  }

  const lookup = proposals.lookup(proposalId);
  const refusal = lookupRefusal(lookup, proposalId, config.proposalTtlMin);
  if (refusal !== null) {
    return {
      ...(refusal.proposal === null
        ? { proposal_id: proposalId }
        : describeProposal(refusal.proposal)),
      ...EMPTY_EXECUTION,
      ...(refusal.supersededBy === undefined ? {} : { superseded_by: refusal.supersededBy }),
      status: 'refused',
      error: refusal.error,
      reason: refusal.reason,
    };
  }
  const proposal = (lookup as { proposal: Proposal }).proposal;
  const described = describeProposal(proposal);

  const read = await reader.read();
  const now = read.state;
  const base = { ...described, ...EMPTY_EXECUTION, billboard_now: board(now) };

  if (!statesEqual(proposal.before, now)) {
    proposals.settle(proposalId, 'stale');
    return {
      ...base,
      status: 'refused',
      error: 'stale',
      reason:
        `the billboard changed since the proposal was made (${describeChange(proposal.before, now)}); ` +
        'nothing was signed. Read it again and make a new proposal if it is still worth it.',
    };
  }

  // Re-plan against the fresh read so the executed transactions are built
  // from the state that was just verified, not from the cached copy.
  const { action } = proposal;
  const youArePoster = read.youArePoster;

  if (action.kind === 'acquire') {
    const replanned = planAcquire(now, {
      bid_sol: lamportsToSol(action.plan.bid),
      message: action.plan.message,
    });
    if (!replanned.ok) {
      proposals.settle(proposalId, 'refused');
      return { ...base, status: 'refused', error: replanned.error, reason: replanned.reason };
    }
    const { plan } = replanned;
    const check = limits === null ? null : limits.checkBid(plan.bid);
    const limitsOut = limitsFromCheck(check);
    if (check !== null && !check.ok) {
      activityLog.append({
        event: 'refused_limit',
        tool: APPROVE_TOOL,
        reasoning: proposal.reasoning,
        proposal_id: proposalId,
        bid_sol: lamportsToSol(plan.bid),
        error: `limit_exceeded: ${check.reason}: ${check.message}`,
        billboard_before: snapshot(now),
      });
      proposals.settle(proposalId, 'refused');
      return {
        ...base,
        status: 'refused',
        error: 'limit_exceeded',
        reason: `${check.message}; the limits are re-checked at approval time and nothing was signed.`,
        limits: limitsOut,
      };
    }
    proposals.approve(proposalId, now);
    const result = await executeAcquire(context, plan, proposal.reasoning, {
      proposalId,
      tool: proposal.tool,
    });
    return finish(context, base, limitsOut, result);
  }

  if (action.kind === 'append') {
    const replanned = planAppend(now, action.plan.message, youArePoster);
    if (!replanned.ok) {
      proposals.settle(proposalId, 'refused');
      return { ...base, status: 'refused', error: replanned.error, reason: replanned.reason };
    }
    proposals.approve(proposalId, now);
    const result = await executeAppend(context, replanned.plan, proposal.reasoning, {
      proposalId,
      tool: proposal.tool,
    });
    return finish(context, base, undefined, result);
  }

  const replanned = planClear(now, youArePoster);
  if (!replanned.ok) {
    proposals.settle(proposalId, 'refused');
    return { ...base, status: 'refused', error: replanned.error, reason: replanned.reason };
  }
  proposals.approve(proposalId, now);
  const result = await executeClear(context, now, proposal.reasoning, {
    proposalId,
    tool: proposal.tool,
  });
  return finish(context, base, undefined, {
    signatures: result.signature === null ? [] : [result.signature],
    transactionsPlanned: 1,
    after: result.after,
    failure: result.failure === null ? null : { ...result.failure, index: 0 },
  });
}

interface ExecutionLike {
  signatures: string[];
  transactionsPlanned: number;
  after: BillboardState;
  failure: { message: string; index: number } | null;
}

function finish(
  context: ServerContext,
  base: Omit<ApproveOutput, 'status' | 'error' | 'reason'>,
  limitsOut: AcquireOutput['limits'] | undefined,
  result: ExecutionLike,
): ApproveOutput {
  const output: ApproveOutput = {
    ...base,
    ...(limitsOut === undefined ? {} : { limits: limitsOut }),
    status: result.failure === null || result.signatures.length > 0 ? 'executed' : 'failed',
    transactions_planned: result.transactionsPlanned,
    transactions_sent: result.signatures.length,
    signatures: result.signatures,
    billboard_after: afterFigures(context, result.after),
  };
  if (result.failure !== null) {
    output.error = 'transaction_failed';
    output.reason =
      result.signatures.length === 0
        ? `the transaction failed, nothing landed: ${result.failure.message}`
        : `${result.signatures.length} of ${result.transactionsPlanned} transactions landed; ` +
          `transaction ${result.failure.index + 1} failed: ${result.failure.message}. ` +
          `The billboard now holds ${result.after.messageBytes} bytes; ` +
          'call append_message with the rest if you still hold the slot.';
  }
  return output;
}

export function formatApproveText(output: ApproveOutput): string {
  let summary: string;
  switch (output.status) {
    case 'refused':
      summary = `Refused (${output.error ?? 'unknown'}): ${output.reason ?? ''} Nothing was signed.`;
      break;
    case 'executed':
      summary =
        output.error === undefined
          ? `Approved and executed ${output.kind ?? 'proposal'} ${output.proposal_id} in ` +
            `${output.transactions_sent} transaction(s); message is now ` +
            `${output.billboard_after?.message_bytes ?? 0} bytes.`
          : `Approved; partially executed: ${output.reason ?? ''}`;
      break;
    case 'failed':
      summary = `Approved but failed: ${output.reason ?? ''}`;
      break;
  }
  return `${summary}\n${JSON.stringify(output, null, 2)}`;
}

export function registerApproveProposal(server: McpServer, context: ServerContext): void {
  server.registerTool(
    APPROVE_TOOL,
    {
      title: 'Approve a proposal',
      description:
        'Sign a proposal made by acquire_posting_rights, append_message or clear_message under ' +
        'AUTO_BID=false. Re-reads the billboard and refuses if the poster, amount or message ' +
        'changed since the proposal (stale), re-checks MAX_BID_SOL and DAILY_CAP_SOL, then ' +
        'executes and logs. Proposals expire after PROPOSAL_TTL_MIN minutes (default 60) and can ' +
        'be approved once; a tool has one open proposal at a time, so proposing again refuses the ' +
        'older id with `superseded` and names its replacement. This is the call to put a ' +
        'permission prompt on: the server cannot see the human, only this call.',
      inputSchema: approveInputShape,
      outputSchema: approveOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      let output: ApproveOutput | { text: string };
      try {
        output = await approveProposal(context, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `${APPROVE_TOOL} failed: ${message}` }],
        };
      }
      if ('text' in output) {
        return { isError: true, content: [{ type: 'text', text: output.text }] };
      }
      const isError = output.status !== 'executed' || output.error !== undefined;
      return {
        ...(isError ? { isError: true } : {}),
        content: [{ type: 'text', text: formatApproveText(output) }],
        structuredContent: output,
      };
    },
  );
}
