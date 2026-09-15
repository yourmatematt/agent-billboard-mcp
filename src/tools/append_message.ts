/**
 * `append_message`: add text to the message while the wallet holds the slot.
 *
 * Split like `acquire_posting_rights` so the proposal flow (T11) can reuse
 * the halves:
 *
 *   - `planAppend(state, message, youArePoster)` is pure. It checks that the
 *     wallet is the poster, measures the message in UTF-8 bytes against the
 *     room left under the program's 4096-byte cap, and chunks it at 900
 *     bytes on code point boundaries. It signs nothing and logs nothing.
 *   - `executeAppend(context, plan, ...)` sends one `append` transaction per
 *     chunk, in order, stopping at the first failure. Every landed
 *     transaction is logged as `executed` (never with `bid_sol`: an append
 *     is not spend); the first failure is logged as `failed`.
 *
 * Order of checks in the tool handler:
 *
 *   1. read the billboard                (throws -> isError text)
 *   2. read-only mode -> isError text    (no wallet, so nothing to check)
 *   3. poster check                      (refused: not_poster, logged as
 *                                         `refused_not_poster`, no tx)
 *   4. size check                        (refused: message_too_long, not
 *                                         logged: nothing was going to be
 *                                         signed and no event type fits)
 *   5. propose mode -> store a proposal  (logged as `proposed`; returns a
 *                                         proposal_id for approve_proposal)
 *   6. auto mode -> execute and log
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Transaction } from '@solana/web3.js';
import { z } from 'zod';

import { snapshot } from '../billboard/reader.js';
import { CHUNK_BYTES, chunkMessage, messageByteLength } from '../program/chunk.js';
import { MESSAGE_SIZE, buildAppendIx, type BillboardState } from '../program/layout.js';
import { lamportsToSol } from '../program/math.js';
import type { ServerContext } from '../server.js';
import {
  READ_ONLY_TEXT,
  afterFigures,
  billboardAfterShape,
  describeFailure,
  proposalOutputShape,
  proposedText,
  reasoningSchema,
  safePeek,
  solString,
} from './shared.js';

export const APPEND_TOOL = 'append_message';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const appendInputShape = {
  message: z
    .string()
    .min(1, 'message must not be empty')
    .describe(
      'Text to add to the end of the current message. Measured in UTF-8 bytes; existing bytes ' +
        'plus new bytes must stay within 4096. Longer text is sent as several transactions of ' +
        'up to 900 bytes each, split on character boundaries.',
    ),
  reasoning: reasoningSchema,
};

const appendInputSchema = z.object(appendInputShape);
export type AppendInput = z.infer<typeof appendInputSchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const APPEND_STATUSES = ['proposed', 'refused', 'executed', 'failed'] as const;
export type AppendStatus = (typeof APPEND_STATUSES)[number];

export const APPEND_ERRORS = ['not_poster', 'message_too_long', 'transaction_failed'] as const;
export type AppendErrorCode = (typeof APPEND_ERRORS)[number];

export const appendOutputShape = {
  status: z.enum(APPEND_STATUSES),
  error: z.enum(APPEND_ERRORS).optional(),
  reason: z.string().optional().describe('Human-readable detail for refused and failed outcomes.'),
  current_poster: z.string(),
  current_amount_sol: solString,
  you_are_poster: z.boolean(),
  existing_bytes: z
    .number()
    .int()
    .min(0)
    .describe('Bytes already on the billboard when this call read it.'),
  message_bytes: z.number().int().min(0).describe('UTF-8 bytes in the message you supplied.'),
  total_bytes_after: z
    .number()
    .int()
    .min(0)
    .describe(
      'existing_bytes + message_bytes: what the billboard would hold if every chunk lands.',
    ),
  transactions_planned: z.number().int().min(0),
  transactions_sent: z.number().int().min(0),
  signatures: z.array(z.string()).describe('Transaction signatures, in the order they landed.'),
  billboard_after: billboardAfterShape.optional(),
  ...proposalOutputShape,
};

const appendOutputSchema = z.object(appendOutputShape);
export type AppendOutput = z.infer<typeof appendOutputSchema>;

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

export interface AppendPlan {
  /** The billboard as read before planning: `billboard_before` in the log. */
  before: BillboardState;
  message: string;
  messageBytes: number;
  chunks: string[];
}

export type AppendPlanResult =
  { ok: true; plan: AppendPlan } | { ok: false; error: AppendErrorCode; reason: string };

/**
 * Validates an append against the current state. Pure: no RPC, no log, no
 * signing. `youArePoster` comes from the reader because only it knows the
 * wallet.
 */
export function planAppend(
  before: BillboardState,
  message: string,
  youArePoster: boolean,
): AppendPlanResult {
  if (!youArePoster) {
    return {
      ok: false,
      error: 'not_poster',
      reason:
        `the slot is held by ${before.poster.toBase58()}, not this wallet; the program only lets ` +
        'the current poster append (error 2012). Use acquire_posting_rights to take the slot first.',
    };
  }
  const messageBytes = messageByteLength(message);
  const total = before.messageBytes + messageBytes;
  if (total > MESSAGE_SIZE) {
    return {
      ok: false,
      error: 'message_too_long',
      reason:
        `the billboard already holds ${before.messageBytes} bytes and this message is ${messageBytes} bytes; ` +
        `together ${total} bytes exceeds the ${MESSAGE_SIZE}-byte cap (measured in UTF-8 bytes, not characters). ` +
        `At most ${MESSAGE_SIZE - before.messageBytes} more bytes fit; clear_message frees the space.`,
    };
  }
  return {
    ok: true,
    plan: { before, message, messageBytes, chunks: chunkMessage(message, CHUNK_BYTES) },
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface AppendExecuteOptions {
  /** Stamped on every log entry when executing an approved proposal. */
  proposalId?: string;
  /** Tool name recorded in the log. Default `append_message`. */
  tool?: string;
}

export interface AppendExecuteResult {
  signatures: string[];
  transactionsPlanned: number;
  /** The billboard as read after the last successful transaction. */
  after: BillboardState;
  /** Set when a transaction failed. Earlier transactions still landed. */
  failure: { message: string; signature: string | undefined; index: number } | null;
}

/**
 * Sends one `append` per chunk, in order. Logs `executed` for each landed
 * transaction (the first carries `billboard_before`, the last carries
 * `billboard_after`; none carries `bid_sol`, so the spend limiter ignores
 * them) and `failed` on the first failure, then stops.
 *
 * Throws only if the server is in read-only mode, which the caller must
 * have ruled out already.
 */
export async function executeAppend(
  context: ServerContext,
  plan: AppendPlan,
  reasoning: string,
  options: AppendExecuteOptions = {},
): Promise<AppendExecuteResult> {
  const { config, rpc, activityLog } = context;
  const keypair = config.keypair;
  if (keypair === null) {
    throw new Error('executeAppend called in read-only mode');
  }
  const tool = options.tool ?? APPEND_TOOL;
  const proposalFields =
    options.proposalId === undefined ? {} : { proposal_id: options.proposalId };
  const planned = plan.chunks.length;
  const signatures: string[] = [];
  let after = plan.before;

  for (const [index, chunk] of plan.chunks.entries()) {
    const isFirst = index === 0;
    const isLast = index === planned - 1;
    try {
      const signature = await rpc.sendAndConfirm(
        new Transaction().add(buildAppendIx(keypair.publicKey, chunk)),
        [keypair],
      );
      signatures.push(signature);
      if (isLast) {
        after = await safePeek(context, after);
      }
      activityLog.append({
        event: 'executed',
        tool,
        reasoning,
        ...proposalFields,
        tx: signature,
        ...(isFirst ? { billboard_before: snapshot(plan.before) } : {}),
        ...(isLast ? { billboard_after: snapshot(after) } : {}),
      });
    } catch (err) {
      const failure = describeFailure(err);
      activityLog.append({
        event: 'failed',
        tool,
        reasoning,
        ...proposalFields,
        ...(failure.signature === undefined ? {} : { tx: failure.signature }),
        error: `append chunk ${index + 1} of ${planned}: ${failure.message}`,
        ...(isFirst ? { billboard_before: snapshot(plan.before) } : {}),
      });
      after = await safePeek(context, after);
      return { signatures, transactionsPlanned: planned, after, failure: { ...failure, index } };
    }
  }

  return { signatures, transactionsPlanned: planned, after, failure: null };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

function baseOutput(
  context: ServerContext,
  before: BillboardState,
  messageBytes: number,
): Omit<
  AppendOutput,
  'status' | 'error' | 'reason' | 'billboard_after' | 'proposal_id' | 'expires_at'
> {
  return {
    current_poster: before.poster.toBase58(),
    current_amount_sol: lamportsToSol(before.amount),
    you_are_poster: context.reader.isWalletPoster(before),
    existing_bytes: before.messageBytes,
    message_bytes: messageBytes,
    total_bytes_after: before.messageBytes + messageBytes,
    transactions_planned: 0,
    transactions_sent: 0,
    signatures: [],
  };
}

/**
 * Runs the tool end to end and returns the structured output, or a plain
 * string for the one outcome that has no figures to report (read-only mode).
 */
export async function appendMessage(
  context: ServerContext,
  input: AppendInput,
): Promise<AppendOutput | { text: string }> {
  const { config, activityLog } = context;

  const read = await context.reader.read();
  const before = read.state;
  const messageBytes = messageByteLength(input.message);
  const base = baseOutput(context, before, messageBytes);

  if (config.readOnly || config.keypair === null) {
    return { text: READ_ONLY_TEXT };
  }

  const planned = planAppend(before, input.message, read.youArePoster);
  if (!planned.ok) {
    if (planned.error === 'not_poster') {
      activityLog.append({
        event: 'refused_not_poster',
        tool: APPEND_TOOL,
        reasoning: input.reasoning,
        error: `not_poster: ${planned.reason}`,
        billboard_before: snapshot(before),
      });
    }
    return { ...base, status: 'refused', error: planned.error, reason: planned.reason };
  }
  const { plan } = planned;
  base.transactions_planned = plan.chunks.length;

  if (!config.autoBid) {
    const proposal = context.proposals.create({
      tool: APPEND_TOOL,
      action: { kind: 'append', plan },
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

  const result = await executeAppend(context, plan, input.reasoning);
  const output: AppendOutput = {
    ...base,
    status: result.failure === null || result.signatures.length > 0 ? 'executed' : 'failed',
    transactions_sent: result.signatures.length,
    signatures: result.signatures,
    billboard_after: afterFigures(context, result.after),
  };
  if (result.failure !== null) {
    output.error = 'transaction_failed';
    output.reason =
      result.signatures.length === 0
        ? `the append transaction failed, nothing landed: ${result.failure.message}`
        : `${result.signatures.length} of ${result.transactionsPlanned} transactions landed; ` +
          `transaction ${result.failure.index + 1} failed: ${result.failure.message}. ` +
          `The billboard now holds ${result.after.messageBytes} bytes; call append_message again with the remaining text.`;
  }
  return output;
}

export function formatAppendText(output: AppendOutput): string {
  let summary: string;
  switch (output.status) {
    case 'proposed':
      summary =
        `Proposed: append ${output.message_bytes} bytes in ${output.transactions_planned} transaction(s), ` +
        `taking the message from ${output.existing_bytes} to ${output.total_bytes_after} bytes. ` +
        proposedText(output.proposal_id ?? '?', output.expires_at ?? '?');
      break;
    case 'refused':
      summary = `Refused (${output.error ?? 'unknown'}): ${output.reason ?? ''} Nothing was signed.`;
      break;
    case 'executed':
      summary =
        output.error === undefined
          ? `Appended ${output.message_bytes} bytes in ${output.transactions_sent} transaction(s); ` +
            `message is now ${output.billboard_after?.message_bytes ?? output.total_bytes_after} bytes.`
          : `Partially executed: ${output.reason ?? ''}`;
      break;
    case 'failed':
      summary = `Failed: ${output.reason ?? ''}`;
      break;
  }
  return `${summary}\n${JSON.stringify(output, null, 2)}`;
}

export function registerAppendMessage(server: McpServer, context: ServerContext): void {
  server.registerTool(
    APPEND_TOOL,
    {
      title: 'Append to the message',
      description:
        'Add text to the end of the billboard message. Only works while this wallet holds the ' +
        'slot (check you_are_poster in read_billboard first); otherwise the call is refused ' +
        'before anything is signed. Sizes are UTF-8 bytes: existing bytes plus new bytes must ' +
        'stay within 4096. Text over 900 bytes is sent as several transactions, in order, and ' +
        'the call stops at the first failure. Every outcome is logged with your reasoning. ' +
        'Under AUTO_BID=false this returns status "proposed" and signs nothing; call ' +
        'approve_proposal to sign.',
      inputSchema: appendInputShape,
      outputSchema: appendOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      let output: AppendOutput | { text: string };
      try {
        output = await appendMessage(context, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `${APPEND_TOOL} failed: ${message}` }],
        };
      }
      if ('text' in output) {
        return { isError: true, content: [{ type: 'text', text: output.text }] };
      }
      const isError =
        (output.status !== 'executed' && output.status !== 'proposed') ||
        output.error !== undefined;
      return {
        ...(isError ? { isError: true } : {}),
        content: [{ type: 'text', text: formatAppendText(output) }],
        structuredContent: output,
      };
    },
  );
}
