/**
 * `acquire_posting_rights`: take the slot, optionally posting a message in
 * the same transaction.
 *
 * The call is split into two halves so the proposal flow (T11) can reuse
 * them:
 *
 *   - `planAcquire(state, input)` is pure. It resolves the bid (default: the
 *     program minimum), checks it against the minimum, sizes the message
 *     against the 4096-byte cap and chunks it, and computes every figure a
 *     dry run reports. It signs nothing and logs nothing.
 *   - `executeAcquire(context, plan, ...)` sends the transactions: one
 *     `acquire` (plus the first message chunk when it fits, see
 *     `COMBINED_CHUNK_BYTES`), then one `append` per remaining chunk, in
 *     order, stopping at the first failure. Every transaction is logged as
 *     it lands; a failure is logged and reported with how many landed.
 *
 * Order of checks in the tool handler, and what each produces:
 *
 *   1. read the billboard                       (throws -> isError text)
 *   2. plan: bid, minimum, message, chunks      (refused: invalid_bid,
 *                                                below_minimum, message_too_long;
 *                                                not logged, nothing was
 *                                                going to be signed)
 *   3. dry_run -> return the figures            (never logged)
 *   4. read-only mode -> isError text
 *   5. spend limits                              (refused: limit_exceeded,
 *                                                logged as `refused_limit`)
 *   6. propose mode -> store a proposal         (logged as `proposed`; the
 *                                                figures come back with a
 *                                                proposal_id for approve_proposal)
 *   7. auto mode -> execute and log
 *
 * Money is `bigint` lamports internally and decimal SOL strings at the edge.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Transaction } from '@solana/web3.js';
import { z } from 'zod';

import { snapshot } from '../billboard/reader.js';
import { chunkForAcquire, messageByteLength } from '../program/chunk.js';
import {
  MESSAGE_SIZE,
  buildAcquireIx,
  buildAppendIx,
  type BillboardState,
} from '../program/layout.js';
import {
  MathError,
  ifOutbidAtMinimum,
  lamportsToSol,
  minimumBid,
  solToLamports,
  splitOnAcquire,
  type AcquireSplit,
  type OutbidAtMinimum,
} from '../program/math.js';
import type { ServerContext } from '../server.js';
import type { LimitCheck } from '../spend/limits.js';
import {
  READ_ONLY_TEXT,
  SOL_STRING_RE,
  afterFigures,
  billboardAfterShape,
  describeFailure,
  proposalOutputShape,
  proposedText,
  reasoningSchema,
  safePeek,
  solString,
} from './shared.js';

export const ACQUIRE_TOOL = 'acquire_posting_rights';

/** Re-exported so existing imports keep working; lives in `./shared.ts`. */
export { reasoningSchema };

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const acquireInputShape = {
  bid_sol: z
    .string()
    .regex(
      SOL_STRING_RE,
      'bid_sol must be a plain decimal SOL string with at most 9 decimals, e.g. "0.105"',
    )
    .optional()
    .describe(
      'Bid in SOL as a decimal string, e.g. "0.105". Defaults to the current program minimum ' +
        '(1% over the current amount, rounded down). Must be within MAX_BID_SOL and DAILY_CAP_SOL.',
    ),
  message: z
    .string()
    .optional()
    .describe(
      'Message to post once the slot is yours. Acquiring clears the previous message. ' +
        'Measured in UTF-8 bytes (max 4096); longer messages are sent as several transactions.',
    ),
  reasoning: reasoningSchema,
  dry_run: z
    .boolean()
    .optional()
    .describe(
      'When true, compute every figure and sign nothing. Works in read-only mode. ' +
        'Use it before a real bid.',
    ),
};

const acquireInputSchema = z.object(acquireInputShape);
export type AcquireInput = z.infer<typeof acquireInputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const ACQUIRE_STATUSES = ['dry_run', 'proposed', 'refused', 'executed', 'failed'] as const;
export type AcquireStatus = (typeof ACQUIRE_STATUSES)[number];

export const ACQUIRE_ERRORS = [
  'invalid_bid',
  'below_minimum',
  'message_too_long',
  'limit_exceeded',
  'transaction_failed',
] as const;
export type AcquireErrorCode = (typeof ACQUIRE_ERRORS)[number];

const limitsShape = z
  .object({
    ok: z.boolean().describe('Whether the bid is within MAX_BID_SOL and DAILY_CAP_SOL right now.'),
    reason: z.enum(['max_bid', 'daily_cap']).optional(),
    max_bid_sol: solString,
    daily_cap_sol: solString,
    spent_last_24h_sol: solString,
    remaining_today_sol: solString,
  })
  .describe('Spend-limit check for this bid. Null in read-only mode (no limits configured).');

/**
 * One flat object for every outcome, discriminated by `status`. The MCP
 * output schema must be an object, so this is not a union: fields that
 * only apply to some outcomes are optional.
 */
export const acquireOutputShape = {
  status: z.enum(ACQUIRE_STATUSES),
  error: z.enum(ACQUIRE_ERRORS).optional(),
  reason: z.string().optional().describe('Human-readable detail for refused and failed outcomes.'),
  current_poster: z.string(),
  current_amount_sol: solString,
  you_are_poster: z
    .boolean()
    .describe('True when the wallet already holds the slot; use append_message instead.'),
  minimum_bid_sol: solString,
  bid_sol: solString.describe('The bid this call evaluated (given, or the minimum).'),
  previous_holder_receives_sol: solString
    .optional()
    .describe('Refund to the displaced poster: their stake plus half the increase.'),
  creator_receives_sol: solString.optional(),
  if_outbid_at_minimum_you_receive_sol: solString
    .optional()
    .describe('What you get back if someone later outbids you at the minimum.'),
  limits: limitsShape.nullable(),
  message_bytes: z.number().int().min(0),
  transactions_planned: z.number().int().min(0),
  transactions_sent: z.number().int().min(0),
  signatures: z.array(z.string()).describe('Transaction signatures, in the order they landed.'),
  billboard_after: billboardAfterShape.optional(),
  ...proposalOutputShape,
};

const acquireOutputSchema = z.object(acquireOutputShape);
export type AcquireOutput = z.infer<typeof acquireOutputSchema>;

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

export interface AcquirePlan {
  /** The billboard as read before planning: `billboard_before` in the log. */
  before: BillboardState;
  bid: bigint;
  minimum: bigint;
  split: AcquireSplit;
  outbid: OutbidAtMinimum;
  message: string;
  messageBytes: number;
  /** Chunk that rides in the acquire transaction, or null for no message. */
  first: string | null;
  /** Chunks that each need their own append transaction. */
  rest: string[];
}

export type PlanResult =
  | { ok: true; plan: AcquirePlan }
  | { ok: false; error: AcquireErrorCode; reason: string; bid: bigint | null; minimum: bigint };

/**
 * Resolves and validates a bid and message against the current state.
 * Pure: no RPC, no log, no signing.
 */
export function planAcquire(
  before: BillboardState,
  input: { bid_sol?: string | undefined; message?: string | undefined },
): PlanResult {
  const minimum = minimumBid(before.amount);

  let bid: bigint;
  if (input.bid_sol === undefined) {
    bid = minimum;
  } else {
    try {
      bid = solToLamports(input.bid_sol);
    } catch (err) {
      const detail = err instanceof MathError ? err.message : String(err);
      return { ok: false, error: 'invalid_bid', reason: detail, bid: null, minimum };
    }
  }

  if (bid <= 0n) {
    return {
      ok: false,
      error: 'invalid_bid',
      reason:
        before.amount === 0n
          ? 'nobody has posted yet, so the program minimum is 0; pass a positive bid_sol to make the first post'
          : 'bid_sol must be greater than 0',
      bid,
      minimum,
    };
  }
  if (bid < minimum) {
    return {
      ok: false,
      error: 'below_minimum',
      reason:
        `bid ${lamportsToSol(bid)} SOL is below the program minimum ${lamportsToSol(minimum)} SOL ` +
        `(1% over the current ${lamportsToSol(before.amount)} SOL, rounded down); the program would reject it with error 6000`,
      bid,
      minimum,
    };
  }

  const message = input.message ?? '';
  const messageBytes = messageByteLength(message);
  if (messageBytes > MESSAGE_SIZE) {
    return {
      ok: false,
      error: 'message_too_long',
      reason: `message is ${messageBytes} bytes; the billboard holds at most ${MESSAGE_SIZE} bytes (measured in UTF-8 bytes, not characters)`,
      bid,
      minimum,
    };
  }

  const { first, rest } = chunkForAcquire(message);
  return {
    ok: true,
    plan: {
      before,
      bid,
      minimum,
      split: splitOnAcquire(before.amount, bid),
      outbid: ifOutbidAtMinimum(bid),
      message,
      messageBytes,
      first,
      rest,
    },
  };
}

/** Number of transactions a plan needs: the acquire plus one per extra chunk. */
export function transactionsPlanned(plan: AcquirePlan): number {
  return 1 + plan.rest.length;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ExecuteOptions {
  /** Stamped on every log entry when executing an approved proposal. */
  proposalId?: string;
  /** Tool name recorded in the log. Default `acquire_posting_rights`. */
  tool?: string;
}

export interface ExecuteResult {
  /** Signatures of the transactions that landed, in order. */
  signatures: string[];
  transactionsPlanned: number;
  /** The billboard as read after the last successful transaction. */
  after: BillboardState;
  /** Set when a transaction failed. Earlier transactions still landed. */
  failure: { message: string; signature: string | undefined; index: number } | null;
}

/**
 * Sends the acquire (with the first chunk if any), then the remaining
 * chunks one transaction at a time. Logs `executed` per landed transaction
 * (the acquire entry carries `bid_sol`, append entries do not, so the spend
 * limiter counts the gross bid exactly once) and `failed` on the first
 * failure, then stops.
 *
 * Throws only if the server is in read-only mode, which the caller must
 * have ruled out already.
 */
export async function executeAcquire(
  context: ServerContext,
  plan: AcquirePlan,
  reasoning: string,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const { config, rpc, activityLog, reader } = context;
  const keypair = config.keypair;
  if (keypair === null) {
    throw new Error('executeAcquire called in read-only mode');
  }
  const tool = options.tool ?? ACQUIRE_TOOL;
  const proposalFields =
    options.proposalId === undefined ? {} : { proposal_id: options.proposalId };
  const planned = transactionsPlanned(plan);
  const signatures: string[] = [];
  const bidSol = lamportsToSol(plan.bid);
  const before = snapshot(plan.before);

  // Transaction 1: acquire, plus the first chunk when there is one.
  const tx = new Transaction().add(
    buildAcquireIx(
      { signer: keypair.publicKey, prevPoster: plan.before.poster, creator: plan.before.creator },
      plan.bid,
    ),
  );
  if (plan.first !== null) {
    tx.add(buildAppendIx(keypair.publicKey, plan.first));
  }

  let after: BillboardState;
  try {
    const signature = await rpc.sendAndConfirm(tx, [keypair]);
    signatures.push(signature);
    after = await reader.peek();
    activityLog.append({
      event: 'executed',
      tool,
      reasoning,
      ...proposalFields,
      bid_sol: bidSol,
      tx: signature,
      billboard_before: before,
      billboard_after: snapshot(after),
    });
  } catch (err) {
    const failure = describeFailure(err);
    activityLog.append({
      event: 'failed',
      tool,
      reasoning,
      ...proposalFields,
      bid_sol: bidSol,
      ...(failure.signature === undefined ? {} : { tx: failure.signature }),
      error: failure.message,
      billboard_before: before,
    });
    return {
      signatures,
      transactionsPlanned: planned,
      after: plan.before,
      failure: { ...failure, index: 0 },
    };
  }

  // Remaining chunks, one transaction each, in order.
  for (const [i, chunk] of plan.rest.entries()) {
    const index = i + 1;
    try {
      const signature = await rpc.sendAndConfirm(
        new Transaction().add(buildAppendIx(keypair.publicKey, chunk)),
        [keypair],
      );
      signatures.push(signature);
      activityLog.append({ event: 'executed', tool, reasoning, ...proposalFields, tx: signature });
    } catch (err) {
      const failure = describeFailure(err);
      activityLog.append({
        event: 'failed',
        tool,
        reasoning,
        ...proposalFields,
        ...(failure.signature === undefined ? {} : { tx: failure.signature }),
        error: `append chunk ${index + 1} of ${planned}: ${failure.message}`,
      });
      after = await safePeek(context, after);
      return { signatures, transactionsPlanned: planned, after, failure: { ...failure, index } };
    }
  }

  if (plan.rest.length > 0) {
    after = await safePeek(context, after);
  }
  return { signatures, transactionsPlanned: planned, after, failure: null };
}

// ---------------------------------------------------------------------------
// Output assembly
// ---------------------------------------------------------------------------

export function limitsFromCheck(check: LimitCheck | null): AcquireOutput['limits'] {
  if (check === null) return null;
  return {
    ok: check.ok,
    ...(check.ok ? {} : { reason: check.reason }),
    max_bid_sol: check.max_bid_sol,
    daily_cap_sol: check.daily_cap_sol,
    spent_last_24h_sol: check.spent_last_24h_sol,
    remaining_today_sol: check.remaining_today_sol,
  };
}

function baseOutput(
  context: ServerContext,
  before: BillboardState,
  bid: bigint | null,
  minimum: bigint,
): Pick<
  AcquireOutput,
  | 'current_poster'
  | 'current_amount_sol'
  | 'you_are_poster'
  | 'minimum_bid_sol'
  | 'bid_sol'
  | 'limits'
  | 'message_bytes'
  | 'transactions_planned'
  | 'transactions_sent'
  | 'signatures'
> {
  return {
    current_poster: before.poster.toBase58(),
    current_amount_sol: lamportsToSol(before.amount),
    you_are_poster: context.reader.isWalletPoster(before),
    minimum_bid_sol: lamportsToSol(minimum),
    bid_sol: lamportsToSol(bid ?? minimum),
    limits: null,
    message_bytes: 0,
    transactions_planned: 0,
    transactions_sent: 0,
    signatures: [],
  };
}

function planFigures(
  plan: AcquirePlan,
): Pick<
  AcquireOutput,
  | 'previous_holder_receives_sol'
  | 'creator_receives_sol'
  | 'if_outbid_at_minimum_you_receive_sol'
  | 'message_bytes'
  | 'transactions_planned'
> {
  return {
    previous_holder_receives_sol: lamportsToSol(plan.split.prevPosterReceives),
    creator_receives_sol: lamportsToSol(plan.split.creatorShare),
    if_outbid_at_minimum_you_receive_sol: lamportsToSol(plan.outbid.youReceive),
    message_bytes: plan.messageBytes,
    transactions_planned: transactionsPlanned(plan),
  };
}

/**
 * Runs the tool end to end and returns the structured output, or a plain
 * string for the one outcome that has no figures to report (read-only mode).
 */
export async function acquirePostingRights(
  context: ServerContext,
  input: AcquireInput,
): Promise<AcquireOutput | { text: string }> {
  const { config, limits, activityLog } = context;
  const dryRun = input.dry_run === true;

  const read = await context.reader.read();
  const before = read.state;

  const planned = planAcquire(before, { bid_sol: input.bid_sol, message: input.message });
  if (!planned.ok) {
    return {
      ...baseOutput(context, before, planned.bid, planned.minimum),
      status: 'refused',
      error: planned.error,
      reason: planned.reason,
      message_bytes: input.message === undefined ? 0 : messageByteLength(input.message),
    };
  }
  const { plan } = planned;
  const check = limits === null ? null : limits.checkBid(plan.bid);
  const base = {
    ...baseOutput(context, before, plan.bid, plan.minimum),
    ...planFigures(plan),
    limits: limitsFromCheck(check),
  };

  if (dryRun) {
    return { ...base, status: 'dry_run' };
  }

  if (config.readOnly || config.keypair === null) {
    return { text: `${READ_ONLY_TEXT} Or call again with dry_run: true.` };
  }

  if (check !== null && !check.ok) {
    activityLog.append({
      event: 'refused_limit',
      tool: ACQUIRE_TOOL,
      reasoning: input.reasoning,
      bid_sol: lamportsToSol(plan.bid),
      error: `limit_exceeded: ${check.reason}: ${check.message}`,
      billboard_before: snapshot(before),
    });
    return { ...base, status: 'refused', error: 'limit_exceeded', reason: check.message };
  }

  if (!config.autoBid) {
    const proposal = context.proposals.create({
      tool: ACQUIRE_TOOL,
      action: { kind: 'acquire', plan },
      reasoning: input.reasoning,
      before,
    });
    return {
      ...base,
      status: 'proposed',
      proposal_id: proposal.id,
      expires_at: proposal.expiresAt.toISOString(),
    };
  }

  const result = await executeAcquire(context, plan, input.reasoning);
  const output: AcquireOutput = {
    ...base,
    status:
      result.failure === null ? 'executed' : result.signatures.length > 0 ? 'executed' : 'failed',
    transactions_sent: result.signatures.length,
    signatures: result.signatures,
    billboard_after: afterFigures(context, result.after),
  };
  if (result.failure !== null) {
    output.error = 'transaction_failed';
    output.reason =
      result.signatures.length === 0
        ? `the acquire transaction failed, nothing landed: ${result.failure.message}`
        : `${result.signatures.length} of ${result.transactionsPlanned} transactions landed; ` +
          `transaction ${result.failure.index + 1} failed: ${result.failure.message}. ` +
          'You hold the slot with a partial message; call append_message with the rest.';
  }
  return output;
}

// ---------------------------------------------------------------------------
// Text block and registration
// ---------------------------------------------------------------------------

export function formatAcquireText(output: AcquireOutput): string {
  let summary: string;
  switch (output.status) {
    case 'dry_run':
      summary =
        `Dry run: bid ${output.bid_sol} SOL (minimum ${output.minimum_bid_sol}); ` +
        `previous holder would receive ${output.previous_holder_receives_sol ?? '?'} SOL, ` +
        `creator ${output.creator_receives_sol ?? '?'} SOL; if outbid at the minimum you would receive ` +
        `${output.if_outbid_at_minimum_you_receive_sol ?? '?'} SOL. ` +
        (output.limits === null
          ? 'No limits configured (read-only mode). '
          : output.limits.ok
            ? 'Within limits. '
            : `Would be refused: ${output.limits.reason}. `) +
        `${output.transactions_planned} transaction(s) planned. Nothing was signed.`;
      break;
    case 'proposed':
      summary =
        `Proposed: bid ${output.bid_sol} SOL (minimum ${output.minimum_bid_sol}); ` +
        `previous holder would receive ${output.previous_holder_receives_sol ?? '?'} SOL, ` +
        `creator ${output.creator_receives_sol ?? '?'} SOL; if outbid at the minimum you would receive ` +
        `${output.if_outbid_at_minimum_you_receive_sol ?? '?'} SOL. Within limits. ` +
        `${output.transactions_planned} transaction(s) planned. ` +
        proposedText(output.proposal_id ?? '?', output.expires_at ?? '?');
      break;
    case 'refused':
      summary = `Refused (${output.error ?? 'unknown'}): ${output.reason === undefined ? '' : `${output.reason}. `}Nothing was signed.`;
      break;
    case 'executed':
      summary =
        output.error === undefined
          ? `Acquired the slot at ${output.bid_sol} SOL in ${output.transactions_sent} transaction(s); ` +
            `message is now ${output.billboard_after?.message_bytes ?? 0} bytes.`
          : `Partially executed: ${output.reason ?? ''}`;
      break;
    case 'failed':
      summary = `Failed: ${output.reason ?? ''}`;
      break;
  }
  return `${summary}\n${JSON.stringify(output, null, 2)}`;
}

export function registerAcquirePostingRights(server: McpServer, context: ServerContext): void {
  server.registerTool(
    ACQUIRE_TOOL,
    {
      title: 'Acquire posting rights',
      description:
        'Bid for the billboard slot and optionally post a message in the same transaction. ' +
        'The bid must be at least 1% over the current amount; the displaced poster gets their ' +
        'stake back plus half the increase, the creator gets the other half; acquiring clears the ' +
        'message. Defaults bid_sol to the minimum. Always call read_billboard first and try ' +
        'dry_run: true before bidding. The server enforces MAX_BID_SOL and DAILY_CAP_SOL before ' +
        'signing and logs every outcome with your reasoning. Under AUTO_BID=false this returns ' +
        'status "proposed" with a proposal_id and signs nothing; call approve_proposal to sign.',
      inputSchema: acquireInputShape,
      outputSchema: acquireOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      let output: AcquireOutput | { text: string };
      try {
        output = await acquirePostingRights(context, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `${ACQUIRE_TOOL} failed: ${message}` }],
        };
      }
      if ('text' in output) {
        return { isError: true, content: [{ type: 'text', text: output.text }] };
      }
      const isError =
        output.status === 'refused' || output.status === 'failed' || output.error !== undefined;
      return {
        ...(isError ? { isError: true } : {}),
        content: [{ type: 'text', text: formatAcquireText(output) }],
        structuredContent: output,
      };
    },
  );
}
