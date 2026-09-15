/**
 * `get_flip_history`: who has held the slot, for how much, and for how long.
 *
 * Read-only. Derived from `Acquired` events on-chain, or from `HISTORY_URL`
 * when it is configured and agrees with the live account (see
 * `billboard/history.ts`). Turnover and hold duration are the only demand
 * signals the chain offers. There is no read count, and this tool never
 * reports one.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  loadFlipHistory,
  type FlipHistory,
} from '../billboard/history.js';
import { lamportsToSol } from '../program/math.js';
import type { ServerContext } from '../server.js';
import { solString } from './shared.js';

export const GET_FLIP_HISTORY_TOOL = 'get_flip_history';

export const getFlipHistoryInputShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_HISTORY_LIMIT)
    .optional()
    .describe(
      `Newest flips to return. Default ${DEFAULT_HISTORY_LIMIT}, max ${MAX_HISTORY_LIMIT}.`,
    ),
};

const flipShape = z.object({
  poster: z.string().describe('Base58 public key of the wallet that acquired the slot.'),
  amount_sol: solString.describe('What that wallet paid, in SOL.'),
  timestamp: z
    .string()
    .nullable()
    .describe('ISO 8601 time the acquire landed, or null when the block time is unknown.'),
  tx: z.string().describe('Transaction signature of the acquire.'),
  held_for_seconds: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe(
      'Seconds this wallet held the slot before the next flip. Null for the current holder.',
    ),
});

export const getFlipHistoryOutputShape = {
  flips: z.array(flipShape).describe('Newest first.'),
  summary: z.object({
    flips: z.number().int().min(0).describe('Number of flips in the list.'),
    average_hold_seconds: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Mean of the known hold durations in the list, or null when there are none.'),
    current_hold_seconds: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('How long the current poster has held the slot so far, or null when unknown.'),
  }),
  source: z
    .enum(['history_url', 'on-chain'])
    .describe('Where the list came from. "on-chain" is derived from Acquired events.'),
  fetched_at: z.string(),
};

const getFlipHistoryOutputSchema = z.object(getFlipHistoryOutputShape);
export type GetFlipHistoryOutput = z.infer<typeof getFlipHistoryOutputSchema>;

/**
 * Reads the live account (so a published history can be checked against
 * it), loads the flips, and shapes the tool output. SOL figures are decimal
 * strings; timestamps are ISO 8601.
 */
export async function getFlipHistory(
  context: ServerContext,
  input: { limit?: number } = {},
): Promise<GetFlipHistoryOutput> {
  const current = await context.reader.peek();
  const fetchedAt = context.now();
  const limit = input.limit ?? DEFAULT_HISTORY_LIMIT;
  const history = await loadFlipHistory(context.rpc, {
    current,
    historyUrl: context.config.historyUrl,
    limit,
    nowSeconds: Math.floor(fetchedAt.getTime() / 1000),
    fetch: context.fetch,
    warn: context.warn,
  });
  return shapeHistory(history, fetchedAt);
}

export function shapeHistory(history: FlipHistory, fetchedAt: Date): GetFlipHistoryOutput {
  return {
    flips: history.flips.map((flip) => ({
      poster: flip.poster.toBase58(),
      amount_sol: lamportsToSol(flip.amount),
      timestamp: flip.timestamp === null ? null : new Date(flip.timestamp * 1000).toISOString(),
      tx: flip.tx,
      held_for_seconds: flip.heldForSeconds,
    })),
    summary: {
      flips: history.summary.flips,
      average_hold_seconds: history.summary.averageHoldSeconds,
      current_hold_seconds: history.summary.currentHoldSeconds,
    },
    source: history.source,
    fetched_at: fetchedAt.toISOString(),
  };
}

function describeSeconds(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}

/** The human-readable block: a summary line, one line per flip, then the JSON. */
export function formatFlipHistoryText(output: GetFlipHistoryOutput): string {
  const where = output.source === 'history_url' ? 'HISTORY_URL' : 'on-chain Acquired events';
  const lines: string[] = [
    `Flip history (${output.summary.flips} flips, newest first, from ${where}). ` +
      `Current holder for ${describeSeconds(output.summary.current_hold_seconds)}; ` +
      `average hold ${describeSeconds(output.summary.average_hold_seconds)}. ` +
      'Turnover and hold duration are the only demand signals; there is no read count.',
  ];
  for (const flip of output.flips) {
    const held =
      flip.held_for_seconds === null
        ? 'still holding'
        : `held ${describeSeconds(flip.held_for_seconds)}`;
    lines.push(
      `- ${flip.timestamp ?? 'time unknown'}  ${flip.poster}  ${flip.amount_sol} SOL  ${held}`,
    );
  }
  lines.push(JSON.stringify(output, null, 2));
  return lines.join('\n');
}

export function registerGetFlipHistory(server: McpServer, context: ServerContext): void {
  server.registerTool(
    GET_FLIP_HISTORY_TOOL,
    {
      title: 'Flip history',
      description:
        'List who has held the billboard, what they paid and how long they held it, newest ' +
        'first, with the average hold and how long the current poster has held it. Derived ' +
        'from on-chain Acquired events (or a published history that agrees with the chain). ' +
        'Turnover and hold duration are the only demand signals; there is no read count.',
      inputSchema: getFlipHistoryInputShape,
      outputSchema: getFlipHistoryOutputShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input): Promise<CallToolResult> => {
      let output: GetFlipHistoryOutput;
      try {
        output = await getFlipHistory(
          context,
          input.limit === undefined ? {} : { limit: input.limit },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `get_flip_history failed: ${message}` }],
        };
      }
      return {
        content: [{ type: 'text', text: formatFlipHistoryText(output) }],
        structuredContent: output,
      };
    },
  );
}
