/**
 * Pieces every write tool shares: the `reasoning` input schema, the SOL
 * string schema, the `billboard_after` output shape, and the failure /
 * re-read helpers used around a transaction.
 *
 * Kept small on purpose. The tools stay readable top to bottom; this file
 * only holds what would otherwise be copied three times.
 */
import { z } from 'zod';

import { MAX_REASONING_CHARS } from '../log/activity.js';
import { MESSAGE_SIZE, type BillboardState } from '../program/layout.js';
import { lamportsToSol } from '../program/math.js';
import { RpcError, describeProgramError } from '../rpc/Rpc.js';
import type { ServerContext } from '../server.js';

export const SOL_STRING_RE = /^\d+(\.\d{1,9})?$/;
export const solString = z.string().regex(SOL_STRING_RE);

/** Shared by every write tool: non-empty, at most MAX_REASONING_CHARS. */
export const reasoningSchema = z
  .string()
  .min(1, 'reasoning must not be empty')
  .max(MAX_REASONING_CHARS, `reasoning must be at most ${MAX_REASONING_CHARS} characters`)
  .refine((s) => s.trim().length > 0, 'reasoning must not be blank')
  .describe(
    'Why you are doing this, in plain language. Written verbatim to the operator activity log ' +
      'beside the transaction signature. Required. At most 2000 characters.',
  );

export const billboardAfterShape = z.object({
  poster: z.string(),
  amount_sol: solString,
  message_bytes: z.number().int().min(0).max(MESSAGE_SIZE),
  you_are_poster: z.boolean(),
});
export type BillboardAfter = z.infer<typeof billboardAfterShape>;

export function afterFigures(context: ServerContext, after: BillboardState): BillboardAfter {
  return {
    poster: after.poster.toBase58(),
    amount_sol: lamportsToSol(after.amount),
    message_bytes: after.messageBytes,
    you_are_poster: context.reader.isWalletPoster(after),
  };
}

/** Text returned by every write tool when no keypair is configured. */
export const READ_ONLY_TEXT =
  'read-only mode: no keypair is configured, so nothing can be signed. ' +
  'Set BILLBOARD_KEYPAIR and MAX_BID_SOL to enable writes.';

/**
 * Output fields every write tool adds when it returns `status: "proposed"`
 * (AUTO_BID=false). Nothing was signed; `approve_proposal` does that.
 */
export const proposalOutputShape = {
  proposal_id: z
    .string()
    .optional()
    .describe('Set when status is "proposed": pass it to approve_proposal to sign.'),
  expires_at: z.iso
    .datetime()
    .optional()
    .describe('Set when status is "proposed": the proposal cannot be approved after this time.'),
};

/** Sentence appended to a proposed outcome's text block. */
export function proposedText(proposalId: string, expiresAt: string): string {
  return (
    `Nothing was signed (AUTO_BID=false). Proposal ${proposalId} expires at ${expiresAt}. ` +
    `To sign it call approve_proposal({ proposal_id: "${proposalId}" }); it re-reads the ` +
    'billboard and refuses if anything changed.'
  );
}

export interface FailureDescription {
  message: string;
  signature: string | undefined;
}

/** Turns a thrown value into a log-friendly message plus the signature, if the RPC had one. */
export function describeFailure(err: unknown): FailureDescription {
  if (err instanceof RpcError) {
    const program =
      err.programError === undefined
        ? ''
        : ` [program error ${describeProgramError(err.programError)}]`;
    return { message: `${err.kind}: ${err.message}${program}`, signature: err.signature };
  }
  return { message: err instanceof Error ? err.message : String(err), signature: undefined };
}

/** Re-reads the billboard after a transaction; a read failure keeps the last known state. */
export async function safePeek(
  context: ServerContext,
  fallback: BillboardState,
): Promise<BillboardState> {
  try {
    return await context.reader.peek();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.warn(`could not re-read the billboard after a transaction (${message})`);
    return fallback;
  }
}
