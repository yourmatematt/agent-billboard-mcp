/**
 * The sandbox rehearsal `init` runs on the spot.
 *
 * The real server, the real tools and the operator's own limits, run in this
 * process against the `default` simulated board (`BILLBOARD_SANDBOX=true`),
 * through an in-memory MCP client: no network, no model, a throwaway wallet
 * that is never funded. The walk is the one an agent makes on its first wake:
 *
 *   read_billboard → acquire_posting_rights dry run at the minimum, with the
 *   first 200 bytes of the belief → the real call → (propose mode)
 *   approve_proposal → read_billboard shows `you_are_poster: true`.
 *
 * One line per step, every line starting `SANDBOX`. When the operator's
 * limits refuse a bid at the sandbox minimum, the refusal is printed as a
 * result (it proves the limit works) and the last read shows the board
 * unchanged. Anything else unexpected throws `RehearsalError`.
 *
 * Nothing is written to the agent folder. The server runs with its working
 * directory in a fresh OS temp folder, so even the sandbox activity log lands
 * there, and that folder is removed when the walk ends. Only `intent.md` is
 * read from the agent folder, so `read_billboard` hands back the operator's
 * real brief. The operator's environment and `.env` are not read: the
 * configuration is exactly the six variables below.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { DEFAULT_SANDBOX_SCENARIO, loadConfig } from '../config.js';
import { chunkMessage } from '../program/chunk.js';
import { createRuntime } from '../runtime.js';
import { createServer } from '../server.js';
import { ACQUIRE_TOOL } from '../tools/acquire_posting_rights.js';
import { APPROVE_TOOL } from '../tools/approve_proposal.js';
import { READ_BILLBOARD_TOOL } from '../tools/read_billboard.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../version.js';
import type { RehearsalInput } from './init.js';

export class RehearsalError extends Error {
  override readonly name = 'RehearsalError';
  constructor(message: string) {
    super(message);
  }
}

/** How much of the belief the rehearsal posts, in UTF-8 bytes. */
export const REHEARSAL_MESSAGE_BYTES = 200;

/** The reasoning every rehearsal write carries. */
export const REHEARSAL_REASONING =
  'init rehearsal on the simulated board: a bid at the minimum with the start of the belief, ' +
  'to show the setup works before the wallet is funded.';

/** Every line the rehearsal prints starts with this. */
export const SANDBOX_PREFIX = 'SANDBOX';

export interface RehearsalStep {
  tool: string;
  isError: boolean;
  structured: Record<string, unknown>;
}

export interface RehearsalResult {
  /** `acquired`: the walk ended as the poster. `refused_limit`: the limits refused the bid. */
  outcome: 'acquired' | 'refused_limit';
  /** Every tool call, in order. */
  steps: RehearsalStep[];
  /** The throwaway wallet's public key. Never the operator's. */
  wallet: string;
}

export interface RehearseOptions {
  /** Where the throwaway working folder is made. Default: the OS temp folder. */
  tmpRoot?: string;
}

/** The first `REHEARSAL_MESSAGE_BYTES` bytes of the belief, cut on a character boundary. */
export function rehearsalMessage(belief: string): string {
  return chunkMessage(belief, REHEARSAL_MESSAGE_BYTES)[0] ?? '';
}

/** Runs the walk and prints one `SANDBOX` line per step. Throws `RehearsalError` if it cannot finish. */
export async function rehearse(
  input: RehearsalInput,
  options: RehearseOptions = {},
): Promise<RehearsalResult> {
  const work = mkdtempSync(join(options.tmpRoot ?? tmpdir(), 'abm-rehearsal-'));
  try {
    const config = loadConfig(
      {
        BILLBOARD_SANDBOX: 'true',
        BILLBOARD_SANDBOX_SCENARIO: DEFAULT_SANDBOX_SCENARIO,
        MAX_BID_SOL: input.maxBidSol,
        DAILY_CAP_SOL: input.dailyCapSol,
        AUTO_BID: input.mode === 'auto' ? 'true' : 'false',
        INTENT_PATH: input.paths.intent,
      },
      { cwd: work, dotenvPath: null },
    );
    const { context } = await createRuntime(config);
    const server = createServer(context);
    const client = new Client({ name: `${PACKAGE_NAME}-init-rehearsal`, version: PACKAGE_VERSION });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const wallet = config.keypair?.publicKey.toBase58() ?? '';
      return { ...(await walk(client, input)), wallet };
    } finally {
      context.proposals.stopSweeper();
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function walk(
  client: Client,
  input: RehearsalInput,
): Promise<Omit<RehearsalResult, 'wallet'>> {
  const say = (text: string): void => input.line(`${SANDBOX_PREFIX} ${text}`);
  const steps: RehearsalStep[] = [];
  const call = async (tool: string, args: Record<string, unknown>): Promise<RehearsalStep> => {
    const result = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    // A result not marked sandbox would mean this is not the simulation. Stop.
    if (structured['sandbox'] !== true) {
      throw new RehearsalError(`${tool} answered without the sandbox mark; stopped`);
    }
    const step = { tool, isError: result.isError === true, structured };
    steps.push(step);
    return step;
  };

  say(
    'Rehearsal: the real server and your limits on a simulated board, in memory, with a throwaway ' +
      'wallet. No network, no model, nothing real is signed.',
  );

  // 1. Read.
  const read = await call(READ_BILLBOARD_TOOL, {});
  if (read.isError) throw new RehearsalError(`${READ_BILLBOARD_TOOL} failed`);
  const operator = read.structured['operator'] as { intent: unknown };
  const minimum = String(read.structured['minimum_bid_sol']);
  say(
    `${READ_BILLBOARD_TOOL}: a simulated poster holds the board at ${String(read.structured['amount_sol'])} SOL; ` +
      `the minimum bid is ${minimum} SOL. ` +
      (typeof operator.intent === 'string'
        ? 'Your intent.md came back as operator.intent.'
        : 'operator.intent is empty: intent.md was not found.'),
  );

  // 2. Dry run at the minimum.
  const message = rehearsalMessage(input.belief);
  const bid = { bid_sol: minimum, message, reasoning: REHEARSAL_REASONING };
  const dry = await call(ACQUIRE_TOOL, { ...bid, dry_run: true });
  if (dry.structured['status'] !== 'dry_run') throw unexpected(ACQUIRE_TOOL, 'dry run', dry);
  const check = dry.structured['limits'] as { ok: boolean; reason?: string } | null;
  say(
    `${ACQUIRE_TOOL}, dry run: ${minimum} SOL with the first ${String(dry.structured['message_bytes'])} bytes ` +
      `of your belief; the previous poster would be paid back ${String(dry.structured['previous_holder_receives_sol'])} SOL. ` +
      (check === null || check.ok
        ? 'Within your limits.'
        : `Your limits would refuse it (${check.reason}).`) +
      ' Nothing signed.',
  );

  // 3. The real call, and in propose mode the approval.
  const real = await call(ACQUIRE_TOOL, bid);
  const status = real.structured['status'];
  if (status === 'refused' && real.structured['error'] === 'limit_exceeded') {
    say(
      `${ACQUIRE_TOOL}: refused, limit_exceeded. ${sentence(String(real.structured['reason']))} ` +
        'Nothing was signed: that is your limit working.',
    );
    const after = await call(READ_BILLBOARD_TOOL, {});
    if (after.isError || after.structured['you_are_poster'] !== false) {
      throw new RehearsalError(
        `${READ_BILLBOARD_TOOL} after the refusal did not show the board unchanged`,
      );
    }
    say(
      `${READ_BILLBOARD_TOOL}: you_are_poster: false. The board is unchanged at ` +
        `${String(after.structured['amount_sol'])} SOL.`,
    );
    say(
      'Rehearsal finished: your limits refused a bid at the simulated minimum. ' +
        'On the real board the minimum is set by whoever posted last.',
    );
    return { outcome: 'refused_limit', steps };
  }
  if (status === 'proposed') {
    const id = String(real.structured['proposal_id']);
    say(`${ACQUIRE_TOOL}: proposed (${id}). In propose mode nothing is signed until you approve.`);
    const approved = await call(APPROVE_TOOL, { proposal_id: id });
    if (approved.structured['status'] !== 'executed') {
      throw unexpected(APPROVE_TOOL, 'approval', approved);
    }
    say(
      `${APPROVE_TOOL}: approved. Acquired at ${minimum} SOL in ` +
        `${transactions(approved)}, signed by the throwaway wallet.`,
    );
  } else if (status === 'executed') {
    say(
      `${ACQUIRE_TOOL}: acquired at ${minimum} SOL in ${transactions(real)}, signed by the ` +
        'throwaway wallet. Auto mode: no approval asked, within your limits.',
    );
  } else {
    throw unexpected(ACQUIRE_TOOL, 'bid', real);
  }

  // 4. Read again: the agent is the poster.
  const after = await call(READ_BILLBOARD_TOOL, {});
  if (after.isError || after.structured['you_are_poster'] !== true) {
    throw new RehearsalError(`${READ_BILLBOARD_TOOL} after the bid did not show you as the poster`);
  }
  say(
    `${READ_BILLBOARD_TOOL}: you_are_poster: true. Your message is up at ` +
      `${String(after.structured['amount_sol'])} SOL.`,
  );
  say("Rehearsal passed. On the real board the same steps spend your wallet's SOL.");
  return { outcome: 'acquired', steps };
}

/** The server's reason as a sentence: capitalised, ending in a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  const capped = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

function transactions(step: RehearsalStep): string {
  const sent = Number(step.structured['transactions_sent']);
  return `${sent} simulated transaction${sent === 1 ? '' : 's'}`;
}

function unexpected(tool: string, what: string, step: RehearsalStep): RehearsalError {
  const status = String(step.structured['status']);
  const error = step.structured['error'];
  const reason = step.structured['reason'];
  return new RehearsalError(
    `${tool} ${what} ended ${status}` +
      (typeof error === 'string' ? ` (${error})` : '') +
      (typeof reason === 'string' ? `: ${reason}` : ''),
  );
}
