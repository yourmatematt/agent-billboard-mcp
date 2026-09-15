import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { solToLamports } from '../../src/program/math.js';
import { MockRpc } from '../../src/rpc/MockRpc.js';
import { createContext, createServer, type ServerContext } from '../../src/server.js';
import {
  GET_FLIP_HISTORY_TOOL,
  getFlipHistoryOutputShape,
  type GetFlipHistoryOutput,
} from '../../src/tools/get_flip_history.js';

const us = Keypair.generate();
const rival = Keypair.generate();
const third = Keypair.generate();
const sol = (s: string) => solToLamports(s);

let dir: string;
let warnings: string[];
const open: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-history-'));
  warnings = [];
});
afterEach(async () => {
  while (open.length > 0) await open.pop()!();
  rmSync(dir, { recursive: true, force: true });
});

type FetchImpl = typeof globalThis.fetch;

function makeContext(rpc: MockRpc, env: NodeJS.ProcessEnv = {}, fetch?: FetchImpl): ServerContext {
  const config = loadConfig(
    {
      ACTIVITY_LOG_PATH: join(dir, 'activity.jsonl'),
      INTENT_PATH: join(dir, 'intent.md'),
      ...env,
    },
    { cwd: dir, dotenvPath: null },
  );
  // The context clock follows the mock chain clock so hold durations line up.
  const options: Parameters<typeof createContext>[2] = {
    now: () => new Date(rpc.now() * 1000),
    warn: (m) => warnings.push(m),
  };
  if (fetch) options.fetch = fetch;
  return createContext(config, rpc, options);
}

async function connect(context: ServerContext): Promise<{ client: Client; server: McpServer }> {
  const server = createServer(context);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, server };
}

async function callHistory(client: Client, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name: GET_FLIP_HISTORY_TOOL, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === 'text')?.text ?? '';
  return {
    isError: result.isError === true,
    text,
    structured: result.structuredContent as GetFlipHistoryOutput | undefined,
  };
}

function fakeFetch(body: unknown): FetchImpl {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as FetchImpl;
}

describe('get_flip_history', () => {
  it('is registered with the exact name and a read-only annotation', async () => {
    const rpc = new MockRpc({ poster: rival.publicKey, amount: sol('0.1') });
    const { client } = await connect(makeContext(rpc));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'get_flip_history');
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.inputSchema.properties).toHaveProperty('limit');
  });

  it('returns two flips with a hold duration after two acquires on the mock', async () => {
    const rpc = new MockRpc({ poster: rival.publicKey, amount: sol('0.1'), message: 'old' });
    const context = makeContext(rpc, {
      BILLBOARD_KEYPAIR: bs58.encode(us.secretKey),
      MAX_BID_SOL: '0.5',
    });
    const { client } = await connect(context);

    await rpc.acquireAs(us, sol('0.101'), 'ours');
    rpc.advanceClock(3_600);
    await rpc.acquireAs(third, sol('0.2'));
    rpc.advanceClock(120);

    const { isError, text, structured } = await callHistory(client);
    expect(isError).toBe(false);
    expect(structured).toBeDefined();
    expect(() => z.object(getFlipHistoryOutputShape).parse(structured)).not.toThrow();

    const out = structured!;
    expect(out.source).toBe('on-chain');
    expect(out.flips).toHaveLength(2);
    expect(out.flips[0]).toMatchObject({
      poster: third.publicKey.toBase58(),
      amount_sol: '0.2',
      held_for_seconds: null,
      tx: rpc.transactions[1]!.signature,
    });
    expect(out.flips[1]).toMatchObject({
      poster: us.publicKey.toBase58(),
      amount_sol: '0.101',
      held_for_seconds: 3_601,
      tx: rpc.transactions[0]!.signature,
    });
    expect(out.flips[0]!.timestamp).toBe(
      new Date(rpc.transactions[1]!.blockTime! * 1000).toISOString(),
    );
    expect(out.summary).toEqual({
      flips: 2,
      average_hold_seconds: 3_601,
      current_hold_seconds: 120,
    });
    expect(out.fetched_at).toBe(new Date(rpc.now() * 1000).toISOString());

    expect(text).toMatch(/2 flips, newest first, from on-chain Acquired events/);
    expect(text).toMatch(/there is no read count/);
    expect(text).toContain(third.publicKey.toBase58());
    expect(text).not.toMatch(/read_count|reads:/i);
  });

  it('logs outbid_detected when the history read is the first to see we lost the slot', async () => {
    const rpc = new MockRpc({ poster: rival.publicKey, amount: sol('0.1') });
    const context = makeContext(rpc, {
      BILLBOARD_KEYPAIR: bs58.encode(us.secretKey),
      MAX_BID_SOL: '0.5',
    });
    const { client } = await connect(context);
    await rpc.acquireAs(us, sol('0.101'));
    await context.reader.read(); // the process knows we are poster
    await rpc.acquireAs(third, sol('0.2'));

    await callHistory(client);
    const events = context.activityLog.entries().map((e) => e.event);
    expect(events).toEqual(['outbid_detected']);
  });

  it('works in read-only mode with an empty history', async () => {
    const rpc = new MockRpc({ poster: rival.publicKey, amount: sol('0.1') });
    const { client } = await connect(makeContext(rpc));
    const { isError, structured } = await callHistory(client);
    expect(isError).toBe(false);
    expect(structured!.flips).toEqual([]);
    expect(structured!.summary).toEqual({
      flips: 0,
      average_hold_seconds: null,
      current_hold_seconds: null,
    });
  });

  it('honours limit and rejects out-of-range values', async () => {
    const rpc = new MockRpc({ poster: rival.publicKey, amount: sol('0.1') });
    const { client } = await connect(makeContext(rpc));
    await rpc.acquireAs(us, sol('0.101'));
    await rpc.acquireAs(third, sol('0.2'));
    await rpc.acquireAs(rival, sol('0.3'));

    const limited = await callHistory(client, { limit: 2 });
    expect(limited.structured!.flips).toHaveLength(2);
    expect(limited.structured!.flips[0]!.poster).toBe(rival.publicKey.toBase58());

    const tooSmall = await callHistory(client, { limit: 0 });
    expect(tooSmall.isError).toBe(true);
    const tooBig = await callHistory(client, { limit: 10_000 });
    expect(tooBig.isError).toBe(true);
  });

  it('uses HISTORY_URL when it agrees with the chain and reports the source', async () => {
    const rpc = new MockRpc({ poster: rival.publicKey, amount: sol('0.1') });
    await rpc.acquireAs(us, sol('0.101'));
    await rpc.acquireAs(third, sol('0.2'));
    const fetch = fakeFetch([
      {
        wallet: us.publicKey.toBase58(),
        amount: 101_000_000,
        timestamp: rpc.now() - 500,
        tx: 'u1',
      },
      {
        wallet: third.publicKey.toBase58(),
        amount: 200_000_000,
        timestamp: rpc.now() - 100,
        tx: 'u2',
      },
    ]);
    const { client } = await connect(
      makeContext(rpc, { HISTORY_URL: 'https://example.invalid/history.json' }, fetch),
    );
    const { structured, text } = await callHistory(client);
    expect(structured!.source).toBe('history_url');
    expect(structured!.flips.map((f) => f.tx)).toEqual(['u2', 'u1']);
    expect(structured!.summary).toEqual({
      flips: 2,
      average_hold_seconds: 400,
      current_hold_seconds: 100,
    });
    expect(text).toMatch(/from HISTORY_URL/);
  });

  it('falls back to the chain when HISTORY_URL is malformed, with a warning on stderr', async () => {
    const rpc = new MockRpc({ poster: rival.publicKey, amount: sol('0.1') });
    await rpc.acquireAs(us, sol('0.101'));
    const { client } = await connect(
      makeContext(
        rpc,
        { HISTORY_URL: 'https://example.invalid/history.json' },
        fakeFetch({ not: 'a list' }),
      ),
    );
    const { isError, structured } = await callHistory(client);
    expect(isError).toBe(false);
    expect(structured!.source).toBe('on-chain');
    expect(structured!.flips).toHaveLength(1);
    expect(structured!.flips[0]!.poster).toBe(us.publicKey.toBase58());
    expect(warnings.join('\n')).toMatch(/HISTORY_URL payload is not a history\.json array/);
  });

  it('falls back to the chain when the URL is unreachable', async () => {
    const rpc = new MockRpc({ poster: rival.publicKey, amount: sol('0.1') });
    await rpc.acquireAs(us, sol('0.101'));
    const unreachable = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchImpl;
    const { client } = await connect(
      makeContext(rpc, { HISTORY_URL: 'https://example.invalid/history.json' }, unreachable),
    );
    const { isError, structured } = await callHistory(client);
    expect(isError).toBe(false);
    expect(structured!.source).toBe('on-chain');
    expect(structured!.flips).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/could not be fetched \(fetch failed\)/);
  });

  it('returns isError when the account cannot be read', async () => {
    const rpc = new MockRpc({ poster: rival.publicKey, amount: sol('0.1') });
    const context = makeContext(rpc);
    rpc.getAccount = async () => null;
    const { client } = await connect(context);
    const { isError, text } = await callHistory(client);
    expect(isError).toBe(true);
    expect(text).toMatch(/get_flip_history failed: /);
  });
});
