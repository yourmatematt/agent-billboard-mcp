/**
 * Labelling (S3): a sandbox result says so, a real one does not, and a
 * simulated signature can never be mistaken for a mainnet one.
 *
 * The same walk runs twice against the same seeded board — once with
 * `BILLBOARD_SANDBOX=true` and an ephemeral wallet, once on the real code
 * path with a keypair from the environment — and every tool is called in
 * both. What the two runs are checked for is deliberately asymmetric:
 *
 *   - sandbox: every text block opens with the marker, every structured
 *     result carries `sandbox: true`, and nothing anywhere in the output
 *     looks like a base58 signature;
 *   - real: no text block mentions the sandbox at all, and the structured
 *     result is the 0.2.0 shape plus exactly one new field, `sandbox: false`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRuntime } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { MOCK_SIGNATURE_RE } from '../src/rpc/MockRpc.js';
import { createContext, createServer } from '../src/server.js';
import { createSandboxRpc } from '../src/sandbox.js';
import { ACQUIRE_TOOL } from '../src/tools/acquire_posting_rights.js';
import { APPEND_TOOL } from '../src/tools/append_message.js';
import { APPROVE_TOOL } from '../src/tools/approve_proposal.js';
import { CLEAR_TOOL } from '../src/tools/clear_message.js';
import { GET_FLIP_HISTORY_TOOL } from '../src/tools/get_flip_history.js';
import { READ_BILLBOARD_TOOL, SANDBOX_URL_NOTE } from '../src/tools/read_billboard.js';
import { SANDBOX_NOTICE } from '../src/tools/shared.js';

/**
 * A base58 run long enough to be a Solana transaction signature. Public keys
 * are 32–44 characters, so this matches signatures and not posters.
 */
const BASE58_SIGNATURE_RE = /[1-9A-HJ-NP-Za-km-z]{64,88}/;

/**
 * The top-level fields each tool returned in 0.2.0. `sandbox` is the only
 * field this phase adds; if a walk produces anything else, the promise that
 * the real board's output is unchanged has been broken.
 */
/**
 * Top-level fields 0.4.0 adds, on the real board and in the sandbox alike.
 * Named here so the check above stays a check: anything not listed still fails.
 */
const KEYS_ADDED_0_4_0: Readonly<Record<string, readonly string[]>> = {
  [READ_BILLBOARD_TOOL]: ['first_read'],
};

const KEYS_0_2_0: Readonly<Record<string, readonly string[]>> = {
  [READ_BILLBOARD_TOOL]: [
    'poster',
    'amount_sol',
    'minimum_bid_sol',
    'message',
    'message_bytes',
    'you_are_poster',
    'operator',
    'changed_since_last_read',
    'fetched_at',
    'public_state_url',
    'site_url',
  ],
  [ACQUIRE_TOOL]: [
    'status',
    'error',
    'reason',
    'current_poster',
    'current_amount_sol',
    'you_are_poster',
    'minimum_bid_sol',
    'bid_sol',
    'previous_holder_receives_sol',
    'creator_receives_sol',
    'if_outbid_at_minimum_you_receive_sol',
    'limits',
    'message_bytes',
    'transactions_planned',
    'transactions_sent',
    'signatures',
    'billboard_after',
    'proposal_id',
    'expires_at',
  ],
  [APPEND_TOOL]: [
    'status',
    'error',
    'reason',
    'current_poster',
    'current_amount_sol',
    'you_are_poster',
    'existing_bytes',
    'message_bytes',
    'total_bytes_after',
    'transactions_planned',
    'transactions_sent',
    'signatures',
    'billboard_after',
    'proposal_id',
    'expires_at',
  ],
  [CLEAR_TOOL]: [
    'status',
    'error',
    'reason',
    'current_poster',
    'current_amount_sol',
    'you_are_poster',
    'existing_bytes',
    'transactions_sent',
    'signatures',
    'billboard_after',
    'proposal_id',
    'expires_at',
  ],
  [APPROVE_TOOL]: [
    'status',
    'error',
    'reason',
    'proposal_id',
    'superseded_by',
    'kind',
    'tool',
    'reasoning',
    'proposed_at',
    'expires_at',
    'bid_sol',
    'billboard_at_proposal',
    'billboard_now',
    'limits',
    'transactions_planned',
    'transactions_sent',
    'signatures',
    'billboard_after',
  ],
  [GET_FLIP_HISTORY_TOOL]: ['flips', 'summary', 'source', 'fetched_at'],
};

const WHY = 'Labelling walk: every tool is called once so its marker can be checked.';

interface Call {
  tool: string;
  text: string;
  structured: Record<string, unknown> | undefined;
}

let dir: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-label-'));
});
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs every tool once against the same seeded board, in sandbox or on the
 * real code path. AUTO_BID is on in both so the write tools execute rather
 * than propose, which is what puts signatures in the output.
 */
async function walk(sandbox: boolean): Promise<Call[]> {
  const common = {
    AUTO_BID: 'true',
    INTENT_PATH: join(dir, 'intent.md'),
  };
  let context;
  if (sandbox) {
    const config = loadConfig(
      { BILLBOARD_SANDBOX: 'true', ...common },
      { cwd: dir, dotenvPath: null },
    );
    ({ context } = await createRuntime(config));
  } else {
    const config = loadConfig(
      {
        BILLBOARD_KEYPAIR: bs58.encode(Keypair.generate().secretKey),
        MAX_BID_SOL: '1',
        ACTIVITY_LOG_PATH: join(dir, 'billboard-activity.jsonl'),
        ...common,
      },
      { cwd: dir, dotenvPath: null },
    );
    context = createContext(config, await createSandboxRpc('default'));
  }

  const server = createServer(context);
  const client = new Client({ name: 'labelling-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });

  const calls: Call[] = [];
  const call = async (tool: string, args: Record<string, unknown>): Promise<void> => {
    const result = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
    const first = result.content[0];
    calls.push({
      tool,
      text: first !== undefined && first.type === 'text' ? first.text : '',
      structured: result.structuredContent as Record<string, unknown> | undefined,
    });
  };

  await call(READ_BILLBOARD_TOOL, {});
  await call(ACQUIRE_TOOL, { reasoning: WHY, dry_run: true });
  await call(ACQUIRE_TOOL, { reasoning: WHY, message: 'ours now' });
  await call(APPEND_TOOL, { message: ' and more', reasoning: WHY });
  await call(CLEAR_TOOL, { reasoning: WHY });
  await call(GET_FLIP_HISTORY_TOOL, {});
  // Refused, and that is the point: approve_proposal must be labelled on the
  // outcome an agent is most likely to see first.
  await call(APPROVE_TOOL, { proposal_id: 'prop_nosuchproposal' });
  return calls;
}

describe('a sandbox result says so', () => {
  let calls: Call[];

  beforeEach(async () => {
    calls = await walk(true);
  });

  it('calls all six tools, and every write one lands', () => {
    expect(calls.map((c) => c.tool)).toEqual([
      READ_BILLBOARD_TOOL,
      ACQUIRE_TOOL,
      ACQUIRE_TOOL,
      APPEND_TOOL,
      CLEAR_TOOL,
      GET_FLIP_HISTORY_TOOL,
      APPROVE_TOOL,
    ]);
    expect(calls[2]!.structured!['status']).toBe('executed');
    expect(calls[3]!.structured!['status']).toBe('executed');
    expect(calls[4]!.structured!['status']).toBe('executed');
  });

  it('opens every text block with the marker, on its own first line', () => {
    for (const { tool, text } of calls) {
      expect(text, tool).not.toBe('');
      expect(text.split('\n')[0], tool).toBe(SANDBOX_NOTICE);
    }
  });

  it('carries sandbox: true on every structured result', () => {
    for (const { tool, structured } of calls) {
      expect(structured, tool).toBeDefined();
      expect(structured!['sandbox'], tool).toBe(true);
    }
  });

  it('returns SANDBOX-<counter> signatures and nothing base58-shaped anywhere', () => {
    const signatures = calls.flatMap((c) => (c.structured?.['signatures'] ?? []) as string[]);
    expect(signatures.length).toBeGreaterThan(0);
    for (const signature of signatures) expect(signature).toMatch(MOCK_SIGNATURE_RE);

    for (const { tool, text } of calls) {
      expect(text.match(BASE58_SIGNATURE_RE), tool).toBeNull();
    }
  });

  it('still names the real board in the read, and says the links are not this simulation', () => {
    const read = calls[0]!;
    expect(read.structured!['public_state_url']).toBe('https://i.xn--5t8h.ws/billboard.json');
    expect(read.structured!['site_url']).toBe('https://xn--5t8h.ws/');
    expect(read.text).toContain(SANDBOX_URL_NOTE);
  });

  it('writes the flip history from the simulated board with simulated signatures', () => {
    const flips = calls[5]!.structured!['flips'] as Array<{ tx: string }>;
    expect(flips.length).toBeGreaterThan(0);
    for (const flip of flips) expect(flip.tx).toMatch(MOCK_SIGNATURE_RE);
  });
});

describe('a real result is unchanged apart from sandbox: false', () => {
  let calls: Call[];

  beforeEach(async () => {
    calls = await walk(false);
  });

  it('never mentions the sandbox in any text block', () => {
    for (const { tool, text } of calls) {
      expect(text, tool).not.toContain(SANDBOX_NOTICE);
      expect(text, tool).not.toContain(SANDBOX_URL_NOTE);
      expect(text.toLowerCase(), tool).not.toContain('sandbox —');
    }
  });

  it('carries sandbox: false on every structured result', () => {
    for (const { tool, structured } of calls) {
      expect(structured, tool).toBeDefined();
      expect(structured!['sandbox'], tool).toBe(false);
    }
  });

  it('adds sandbox and nothing else to the 0.2.0 field set (plus the named 0.4.0 fields)', () => {
    for (const { tool, structured } of calls) {
      const keys = Object.keys(structured!);
      expect(keys, tool).toContain('sandbox');
      const before = keys.filter((k) => k !== 'sandbox');
      const allowed = [...KEYS_0_2_0[tool]!, ...(KEYS_ADDED_0_4_0[tool] ?? [])];
      expect(
        before.filter((k) => !allowed.includes(k)),
        tool,
      ).toEqual([]);
    }
  });

  it('puts the same fields in the text block as in the structured result', () => {
    for (const { tool, text, structured } of calls) {
      const start = text.indexOf('\n{');
      expect(start, tool).toBeGreaterThan(-1);
      const embedded = JSON.parse(text.slice(start + 1)) as Record<string, unknown>;
      expect(embedded['sandbox'], tool).toBe(false);
      expect(Object.keys(embedded), tool).toEqual(Object.keys(structured!));
    }
  });
});
