/**
 * `clear_message`: empty the message while the wallet holds the slot.
 *
 * One transaction, one `clear` instruction. Refused before any signing when
 * the wallet is not the poster (logged as `refused_not_poster`) or when the
 * message is already empty (not logged: nothing was going to be signed and
 * paying a fee to change nothing helps nobody).
 *
 * `executeClear` is separate from the handler so `approve_proposal` can
 * call it for an approved proposal. Under AUTO_BID=false the handler stores
 * a proposal (logged as `proposed`) and returns its id instead of signing.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Transaction } from '@solana/web3.js';
import { z } from 'zod';

import { snapshot } from '../billboard/reader.js';
import { buildClearIx, type BillboardState } from '../program/layout.js';
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

export const CLEAR_TOOL = 'clear_message';

export const clearInputShape = {
  reasoning: reasoningSchema,
};

const clearInputSchema = z.object(clearInputShape);
export type ClearInput = z.infer<typeof clearInputSchema>;

export const CLEAR_STATUSES = ['proposed', 'refused', 'executed', 'failed'] as const;
export type ClearStatus = (typeof CLEAR_STATUSES)[number];

export const CLEAR_ERRORS = ['not_poster', 'already_empty', 'transaction_failed'] as const;
export type ClearErrorCode = (typeof CLEAR_ERRORS)[number];

export const clearOutputShape = {
  status: z.enum(CLEAR_STATUSES),
  error: z.enum(CLEAR_ERRORS).optional(),
  reason: z.string().optional().describe('Human-readable detail for refused and failed outcomes.'),
  current_poster: z.string(),
  current_amount_sol: solString,
  you_are_poster: z.boolean(),
  existing_bytes: z
    .number()
    .int()
    .min(0)
    .describe('Bytes on the billboard when this call read it (what a clear removes).'),
  transactions_sent: z.number().int().min(0).max(1),
  signatures: z.array(z.string()),
  billboard_after: billboardAfterShape.optional(),
  ...proposalOutputShape,
};

const clearOutputSchema = z.object(clearOutputShape);
export type ClearOutput = z.infer<typeof clearOutputSchema>;

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

export type ClearPlanResult =
  { ok: true; before: BillboardState } | { ok: false; error: ClearErrorCode; reason: string };

export function planClear(before: BillboardState, youArePoster: boolean): ClearPlanResult {
  if (!youArePoster) {
    return {
      ok: false,
      error: 'not_poster',
      reason:
        `the slot is held by ${before.poster.toBase58()}, not this wallet; the program only lets ` +
        'the current poster clear (error 2012).',
    };
  }
  if (before.messageBytes === 0) {
    return {
      ok: false,
      error: 'already_empty',
      reason: 'the message is already empty; a clear would pay a fee to change nothing.',
    };
  }
  return { ok: true, before };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ClearExecuteOptions {
  proposalId?: string;
  tool?: string;
}

export interface ClearExecuteResult {
  signature: string | null;
  after: BillboardState;
  failure: { message: string; signature: string | undefined } | null;
}

/**
 * Sends the one `clear` transaction. Logs `executed` (no `bid_sol`: a clear
 * is not spend) with `billboard_before`/`billboard_after`, or `failed`.
 */
export async function executeClear(
  context: ServerContext,
  before: BillboardState,
  reasoning: string,
  options: ClearExecuteOptions = {},
): Promise<ClearExecuteResult> {
  const { config, rpc, activityLog } = context;
  const keypair = config.keypair;
  if (keypair === null) {
    throw new Error('executeClear called in read-only mode');
  }
  const tool = options.tool ?? CLEAR_TOOL;
  const proposalFields =
    options.proposalId === undefined ? {} : { proposal_id: options.proposalId };

  try {
    const signature = await rpc.sendAndConfirm(
      new Transaction().add(buildClearIx(keypair.publicKey)),
      [keypair],
    );
    const after = await safePeek(context, before);
    activityLog.append({
      event: 'executed',
      tool,
      reasoning,
      ...proposalFields,
      tx: signature,
      billboard_before: snapshot(before),
      billboard_after: snapshot(after),
    });
    return { signature, after, failure: null };
  } catch (err) {
    const failure = describeFailure(err);
    activityLog.append({
      event: 'failed',
      tool,
      reasoning,
      ...proposalFields,
      ...(failure.signature === undefined ? {} : { tx: failure.signature }),
      error: `clear: ${failure.message}`,
      billboard_before: snapshot(before),
    });
    return { signature: null, after: await safePeek(context, before), failure };
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export async function clearMessage(
  context: ServerContext,
  input: ClearInput,
): Promise<ClearOutput | { text: string }> {
  const { config, activityLog } = context;

  const read = await context.reader.read();
  const before = read.state;
  const base = {
    current_poster: before.poster.toBase58(),
    current_amount_sol: lamportsToSol(before.amount),
    you_are_poster: read.youArePoster,
    existing_bytes: before.messageBytes,
    transactions_sent: 0,
    signatures: [] as string[],
  };

  if (config.readOnly || config.keypair === null) {
    return { text: READ_ONLY_TEXT };
  }

  const planned = planClear(before, read.youArePoster);
  if (!planned.ok) {
    if (planned.error === 'not_poster') {
      activityLog.append({
        event: 'refused_not_poster',
        tool: CLEAR_TOOL,
        reasoning: input.reasoning,
        error: `not_poster: ${planned.reason}`,
        billboard_before: snapshot(before),
      });
    }
    return { ...base, status: 'refused', error: planned.error, reason: planned.reason };
  }

  if (!config.autoBid) {
    const proposal = context.proposals.create({
      tool: CLEAR_TOOL,
      action: { kind: 'clear' },
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

  const result = await executeClear(context, before, input.reasoning);
  if (result.failure !== null || result.signature === null) {
    return {
      ...base,
      status: 'failed',
      error: 'transaction_failed',
      reason: `the clear transaction failed, nothing changed: ${result.failure?.message ?? 'unknown'}`,
      billboard_after: afterFigures(context, result.after),
    };
  }
  return {
    ...base,
    status: 'executed',
    transactions_sent: 1,
    signatures: [result.signature],
    billboard_after: afterFigures(context, result.after),
  };
}

export function formatClearText(output: ClearOutput): string {
  let summary: string;
  switch (output.status) {
    case 'proposed':
      summary =
        `Proposed: clear ${output.existing_bytes} bytes in one transaction. ` +
        proposedText(output.proposal_id ?? '?', output.expires_at ?? '?');
      break;
    case 'refused':
      summary = `Refused (${output.error ?? 'unknown'}): ${output.reason ?? ''} Nothing was signed.`;
      break;
    case 'executed':
      summary = `Cleared ${output.existing_bytes} bytes; message is now ${output.billboard_after?.message_bytes ?? 0} bytes.`;
      break;
    case 'failed':
      summary = `Failed: ${output.reason ?? ''}`;
      break;
  }
  return `${summary}\n${JSON.stringify(output, null, 2)}`;
}

export function registerClearMessage(server: McpServer, context: ServerContext): void {
  server.registerTool(
    CLEAR_TOOL,
    {
      title: 'Clear the message',
      description:
        'Empty the billboard message. Only works while this wallet holds the slot; otherwise ' +
        'the call is refused before anything is signed. Posting rights and the staked amount ' +
        'are unchanged. One transaction. Logged with your reasoning. Under AUTO_BID=false this ' +
        'returns status "proposed" and signs nothing; call approve_proposal to sign.',
      inputSchema: clearInputShape,
      outputSchema: clearOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      let output: ClearOutput | { text: string };
      try {
        output = await clearMessage(context, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `${CLEAR_TOOL} failed: ${message}` }],
        };
      }
      if ('text' in output) {
        return { isError: true, content: [{ type: 'text', text: output.text }] };
      }
      const isError = output.status !== 'executed' && output.status !== 'proposed';
      return {
        ...(isError ? { isError: true } : {}),
        content: [{ type: 'text', text: formatClearText(output) }],
        structuredContent: output,
      };
    },
  );
}
