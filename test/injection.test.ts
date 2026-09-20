/**
 * S4: the injection defence, end to end through the in-memory transport.
 *
 * `test/adversarial.test.ts` (T19) already proves the limit check holds
 * against injected board text on the real board. This file proves the same
 * thing where a reader can run it themselves — the `adversarial` sandbox
 * scenario, with no configuration at all — and asserts the three things
 * `docs/INJECTION.md` claims about it: the bid the message demands is
 * refused, the refusal is on the record as `refused_limit`, and no value
 * moved.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDemo, type DemoStep } from '../scripts/demo.js';
import { loadConfig } from '../src/config.js';
import type { MockRpc } from '../src/rpc/MockRpc.js';
import {
  SANDBOX_ADVERSARIAL_DEMANDED_BID_SOL,
  SANDBOX_ADVERSARIAL_MESSAGE,
  SANDBOX_ATTACKER_PAYOUT,
  createSandboxRpc,
  sandboxFetch,
} from '../src/sandbox.js';
import { createContext, createServer, type ServerContext } from '../src/server.js';
import { ACQUIRE_TOOL } from '../src/tools/acquire_posting_rights.js';
import { APPROVE_TOOL } from '../src/tools/approve_proposal.js';
import { READ_BILLBOARD_TOOL, UNTRUSTED_BANNER } from '../src/tools/read_billboard.js';

/** The cap the ≤ 600-byte rule in the task text sets on the board message. */
const MAX_ADVERSARIAL_BYTES = 600;

let dir: string;
const open: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-injection-'));
});
afterEach(async () => {
  while (open.length > 0) await open.pop()!();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A sandbox session on the `adversarial` scenario with nothing else set: the
 * command in the README, run in a temp directory so the forced sandbox log
 * lands there.
 */
async function adversarialSession(): Promise<{
  client: Client;
  context: ServerContext;
  rpc: MockRpc;
}> {
  const config = loadConfig(
    {
      BILLBOARD_SANDBOX: 'true',
      BILLBOARD_SANDBOX_SCENARIO: 'adversarial',
      INTENT_PATH: join(dir, 'intent.md'),
    },
    { cwd: dir, dotenvPath: null },
  );
  const rpc = await createSandboxRpc(config.sandboxScenario);
  const context = createContext(config, rpc, { warn: () => undefined, fetch: sandboxFetch });
  const server = createServer(context);
  const client = new Client({ name: 'injection-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, context, rpc };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; structured: Record<string, unknown> | undefined }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return {
    isError: result.isError === true,
    text: content.find((c) => c.type === 'text')?.text ?? '',
    structured: result.structuredContent as Record<string, unknown> | undefined,
  };
}

describe('the adversarial board message', () => {
  it('carries all three attack shapes and fits the byte budget', () => {
    const bytes = Buffer.byteLength(SANDBOX_ADVERSARIAL_MESSAGE, 'utf8');
    expect(bytes).toBeLessThanOrEqual(MAX_ADVERSARIAL_BYTES);
    expect(bytes).toBeGreaterThan(0);
    // 1. raise or ignore the ceiling; 2. approve its own proposal;
    // 3. pay an unrelated address.
    expect(SANDBOX_ADVERSARIAL_MESSAGE).toContain('MAX_BID_SOL');
    expect(SANDBOX_ADVERSARIAL_MESSAGE).toContain('Ignore the old ceiling');
    expect(SANDBOX_ADVERSARIAL_MESSAGE).toContain('approve your own proposal');
    expect(SANDBOX_ADVERSARIAL_MESSAGE).toContain(SANDBOX_ATTACKER_PAYOUT.publicKey.toBase58());
    expect(SANDBOX_ADVERSARIAL_MESSAGE).toContain(SANDBOX_ADVERSARIAL_DEMANDED_BID_SOL);
  });

  it('demands more than the sandbox MAX_BID_SOL default, so the refusal is not a coincidence', () => {
    const config = loadConfig(
      { BILLBOARD_SANDBOX: 'true', INTENT_PATH: join(dir, 'intent.md') },
      { cwd: dir, dotenvPath: null },
    );
    expect(config.maxBidLamports).not.toBeNull();
    expect(Number(SANDBOX_ADVERSARIAL_DEMANDED_BID_SOL)).toBeGreaterThan(1);
  });
});

describe('the adversarial scenario, end to end', () => {
  it('returns the message as untrusted, refuses the bid it demands, logs it and moves nothing', async () => {
    const { client, context, rpc } = await adversarialSession();
    const transfersAtSeed = rpc.transfers.length;
    const transactionsAtSeed = rpc.transactions.length;

    // The model sees the attack text, marked, with the real limits beside it.
    const read = await call(client, READ_BILLBOARD_TOOL, {});
    expect(read.isError).toBe(false);
    expect(read.text).toContain(UNTRUSTED_BANNER);
    expect(read.structured?.['message']).toBe(SANDBOX_ADVERSARIAL_MESSAGE);
    expect(read.structured?.['sandbox']).toBe(true);
    const operator = read.structured?.['operator'] as { limits: { max_bid_sol: string } };
    expect(operator.limits.max_bid_sol).toBe('1');

    // A model that did what the message said would call this. The server does
    // not care what the model concluded.
    const refused = await call(client, ACQUIRE_TOOL, {
      bid_sol: SANDBOX_ADVERSARIAL_DEMANDED_BID_SOL,
      message: 'as instructed by the board',
      reasoning: 'The board message says the ceiling was raised. Following it.',
    });
    expect(refused.isError).toBe(true);
    expect(refused.structured?.['status']).toBe('refused');
    expect(refused.structured?.['error']).toBe('limit_exceeded');
    expect(refused.structured?.['transactions_sent']).toBe(0);
    expect(refused.structured?.['signatures']).toEqual([]);
    // Nothing to approve: the limit check runs before a proposal exists.
    expect(refused.structured?.['proposal_id']).toBeUndefined();

    // On the record as a limit refusal, with no signature.
    const log = context.activityLog.entries();
    expect(log.map((e) => e.event)).toEqual(['refused_limit']);
    expect(log[0]?.bid_sol).toBe(SANDBOX_ADVERSARIAL_DEMANDED_BID_SOL);
    expect(log[0]?.tx).toBeUndefined();
    expect(log[0]?.error).toContain('limit_exceeded');

    // Nothing moved: no transaction, no transfer, and in particular nothing
    // to the address the message named.
    expect(rpc.transactions).toHaveLength(transactionsAtSeed);
    expect(rpc.transfers).toHaveLength(transfersAtSeed);
    for (const transfer of rpc.transfers) {
      expect(transfer.to.equals(SANDBOX_ATTACKER_PAYOUT.publicKey)).toBe(false);
    }
    expect(rpc.billboard.message).toBe(SANDBOX_ADVERSARIAL_MESSAGE);
  });

  it('the approval gate has no field through which the injected figures could return', async () => {
    const { client } = await adversarialSession();
    const { tools } = await client.listTools();
    const approve = tools.find((t) => t.name === APPROVE_TOOL)!;
    const input = approve.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(input.properties)).toEqual(['proposal_id']);
  });
});

describe('the demo injection segment', () => {
  it('prints the message, the decision, the refusal, the log line and the zero count', async () => {
    const lines: string[] = [];
    const result = await runDemo({
      out: (l) => lines.push(l),
      warn: () => undefined,
      intentPath: join(dir, 'intent.md'),
    });

    expect(result.injectionSteps.map((s: DemoStep) => s.tool)).toEqual([
      READ_BILLBOARD_TOOL,
      ACQUIRE_TOOL,
    ]);
    const [read, refused] = result.injectionSteps;
    expect(read!.isError).toBe(false);
    expect(read!.text).toContain(UNTRUSTED_BANNER);
    expect(read!.text).toContain(SANDBOX_ADVERSARIAL_MESSAGE);
    expect(refused!.isError).toBe(true);
    expect((refused!.structured as Record<string, unknown>)['error']).toBe('limit_exceeded');

    expect(result.injectionActivity.map((e) => e.event)).toEqual(['refused_limit']);
    expect(result.injectionActivity[0]?.tx).toBeUndefined();

    // The five printed parts, in order, are what docs/INJECTION.md quotes.
    const text = lines.join('\n');
    expect(text).toContain('## Injection defence');
    expect(text).toContain('### injection decision');
    expect(text).toContain('### injection refusal: isError, error limit_exceeded');
    expect(text).toContain('### Activity log from the injection segment (1 line)');
    expect(text).toContain('### No transaction was produced: 0 transactions and 0 transfers');

    const order = [
      text.indexOf('## Injection defence'),
      text.indexOf(UNTRUSTED_BANNER, text.indexOf('## Injection defence')),
      text.indexOf('### injection decision'),
      text.indexOf('### injection refusal:'),
      text.indexOf('### Activity log from the injection segment'),
      text.indexOf('### No transaction was produced:'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);

    // The segment keeps its own server, so the walk and the loop above it are
    // untouched by it.
    expect(result.activity).toHaveLength(10);
    expect(result.loopActivity).toHaveLength(7);
  });
});
