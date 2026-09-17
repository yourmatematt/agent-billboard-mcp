import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { solToLamports } from '../../src/program/math.js';
import { MockRpc } from '../../src/rpc/MockRpc.js';
import { RpcError } from '../../src/rpc/Rpc.js';
import { createContext, createServer, type ServerContext } from '../../src/server.js';
import {
  CLEAR_TOOL,
  clearOutputShape,
  planClear,
  type ClearOutput,
} from '../../src/tools/clear_message.js';
import { READ_BILLBOARD_TOOL, type ReadBillboardOutput } from '../../src/tools/read_billboard.js';

const us = Keypair.generate();
const them = Keypair.generate();
const sol = (s: string) => solToLamports(s);
const T0 = new Date('2026-09-14T12:00:00.000Z');

let dir: string;
let warnings: string[];
const open: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-clear-'));
  warnings = [];
});
afterEach(async () => {
  while (open.length > 0) await open.pop()!();
  rmSync(dir, { recursive: true, force: true });
});

const writeEnv = {
  BILLBOARD_KEYPAIR: bs58.encode(us.secretKey),
  MAX_BID_SOL: '0.2',
  DAILY_CAP_SOL: '0.5',
};
const autoEnv = { ...writeEnv, AUTO_BID: 'true' };

function makeContext(rpc: MockRpc, env: NodeJS.ProcessEnv = {}): ServerContext {
  const config = loadConfig(
    { ACTIVITY_LOG_PATH: join(dir, 'activity.jsonl'), INTENT_PATH: join(dir, 'intent.md'), ...env },
    { cwd: dir, dotenvPath: null },
  );
  return createContext(config, rpc, { now: () => T0, warn: (m) => warnings.push(m) });
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

async function callClear(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: CLEAR_TOOL, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === 'text')?.text ?? '';
  return { result, text, structured: result.structuredContent as ClearOutput | undefined };
}

async function callRead(client: Client): Promise<ReadBillboardOutput> {
  const result = await client.callTool({ name: READ_BILLBOARD_TOOL, arguments: {} });
  return result.structuredContent as ReadBillboardOutput;
}

function ours(message = 'ours: open 7–3'): MockRpc {
  return new MockRpc({ poster: us.publicKey, amount: sol('0.101'), message });
}

function theirs(message = 'theirs'): MockRpc {
  return new MockRpc({ poster: them.publicKey, amount: sol('0.1'), message });
}

const REASON = 'The promotion ended; the operator does not want stale hours showing.';

describe('clear_message registration', () => {
  it('is listed with input and output schemas', async () => {
    const { client } = await connect(makeContext(ours()));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === CLEAR_TOOL);
    expect(tool).toBeDefined();
    const input = tool!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(input.properties)).toEqual(['reasoning']);
    expect(input.required).toEqual(['reasoning']);
    const output = (tool!.outputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(output).sort()).toEqual(Object.keys(clearOutputShape).sort());
  });

  it('rejects an empty or blank reasoning before touching anything', async () => {
    const rpc = ours();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    for (const reasoning of ['', '   ']) {
      const { result, text } = await callClear(client, { reasoning });
      expect(result.isError).toBe(true);
      expect(text).toMatch(/reasoning/);
    }
    expect(rpc.transactions).toHaveLength(0);
    expect(rpc.billboard.message).toBe('ours: open 7–3');
    expect(context.activityLog.entries()).toEqual([]);
  });
});

describe('planClear', () => {
  it('refuses a non-poster and an already-empty message', () => {
    const notPoster = planClear(theirs().billboard, false);
    expect(notPoster).toMatchObject({ ok: false, error: 'not_poster' });

    const empty = planClear(ours('').billboard, true);
    expect(empty).toMatchObject({ ok: false, error: 'already_empty' });

    const fine = planClear(ours().billboard, true);
    expect(fine.ok).toBe(true);
  });
});

describe('refusals before any signing', () => {
  it('refuses a non-poster, logs refused_not_poster, sends nothing', async () => {
    const rpc = theirs();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);

    const { result, text, structured } = await callClear(client, { reasoning: REASON });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/^Refused \(not_poster\)/);
    expect(structured).toMatchObject({
      status: 'refused',
      error: 'not_poster',
      current_poster: them.publicKey.toBase58(),
      current_amount_sol: '0.1',
      you_are_poster: false,
      existing_bytes: 6,
      transactions_sent: 0,
      signatures: [],
    });
    expect(rpc.transactions).toHaveLength(0);
    expect(rpc.billboard.message).toBe('theirs');

    const entries = context.activityLog.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: 'refused_not_poster',
      tool: CLEAR_TOOL,
      reasoning: REASON,
      billboard_before: { poster: them.publicKey.toBase58(), amount_sol: '0.1' },
    });
    expect(entries[0]!.error).toMatch(/^not_poster:/);
    expect(entries[0]!.tx).toBeUndefined();
  });

  it('refuses to clear an already-empty message without logging or sending', async () => {
    const rpc = ours('');
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    const { result, structured } = await callClear(client, { reasoning: REASON });
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      status: 'refused',
      error: 'already_empty',
      you_are_poster: true,
      existing_bytes: 0,
    });
    expect(rpc.transactions).toHaveLength(0);
    expect(context.activityLog.entries()).toEqual([]);
  });

  it('returns a clear read-only error when no keypair is configured', async () => {
    const rpc = ours();
    const context = makeContext(rpc);
    const { client } = await connect(context);
    const { result, text } = await callClear(client, { reasoning: REASON });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/read-only mode/);
    expect(rpc.transactions).toHaveLength(0);
    expect(context.activityLog.entries()).toEqual([]);
  });

  it('returns a proposal in propose mode and signs nothing', async () => {
    const rpc = ours();
    const context = makeContext(rpc, writeEnv);
    const { client } = await connect(context);
    const { result, text, structured } = await callClear(client, { reasoning: REASON });
    expect(result.isError).toBeUndefined();
    expect(structured?.status).toBe('proposed');
    expect(structured?.proposal_id).toMatch(/^prop_[0-9a-f]{12}$/);
    expect(structured?.expires_at).toBe(new Date(T0.getTime() + 60 * 60 * 1000).toISOString());
    expect(structured?.signatures).toEqual([]);
    expect(text).toMatch(/approve_proposal/);
    expect(rpc.transactions).toHaveLength(0);
    expect(rpc.billboard.message).toBe('ours: open 7–3');

    const entries = context.activityLog.entries();
    expect(entries.map((e) => e.event)).toEqual(['proposed']);
    expect(entries[0]).toMatchObject({
      tool: CLEAR_TOOL,
      reasoning: REASON,
      proposal_id: structured?.proposal_id,
    });
    expect(entries[0]?.bid_sol).toBeUndefined();
  });
});

describe('execution under AUTO_BID=true', () => {
  it('clears the message in one transaction, keeps the slot, logs without bid_sol', async () => {
    const rpc = ours();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    await callRead(client);

    const { result, text, structured } = await callClear(client, { reasoning: REASON });
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/^Cleared 16 bytes; message is now 0 bytes\./);
    expect(structured).toMatchObject({
      status: 'executed',
      you_are_poster: true,
      existing_bytes: 16,
      transactions_sent: 1,
      billboard_after: {
        poster: us.publicKey.toBase58(),
        amount_sol: '0.101',
        message_bytes: 0,
        you_are_poster: true,
      },
    });
    expect(structured!.error).toBeUndefined();
    expect(structured!.signatures).toHaveLength(1);

    expect(rpc.billboard.message).toBe('');
    expect(rpc.billboard.poster.equals(us.publicKey)).toBe(true);
    expect(rpc.billboard.amount).toBe(sol('0.101'));
    expect(rpc.transactions).toHaveLength(1);

    const entries = context.activityLog.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: 'executed',
      tool: CLEAR_TOOL,
      reasoning: REASON,
      tx: structured!.signatures[0],
      billboard_before: { poster: us.publicKey.toBase58(), amount_sol: '0.101' },
      billboard_after: { poster: us.publicKey.toBase58(), amount_sol: '0.101' },
    });
    expect(entries[0]!.bid_sol).toBeUndefined();
    expect(context.limits!.spentLast24h()).toBe(0n);

    const after = await callRead(client);
    expect(after.changed_since_last_read).toBe(true);
    expect(after.you_are_poster).toBe(true);
    expect(after.message).toBe('');
    expect(after.message_bytes).toBe(0);
  });

  it('reports a failed transaction, logs failed, leaves the message alone', async () => {
    const rpc = ours();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    rpc.failNextSend(
      new RpcError('Simulation failed: blockhash not found', { kind: 'transaction' }),
    );

    const { result, text, structured } = await callClear(client, { reasoning: REASON });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/^Failed: the clear transaction failed, nothing changed/);
    expect(structured).toMatchObject({
      status: 'failed',
      error: 'transaction_failed',
      transactions_sent: 0,
      signatures: [],
      billboard_after: { message_bytes: 16, you_are_poster: true },
    });
    expect(rpc.billboard.message).toBe('ours: open 7–3');
    expect(rpc.transactions).toHaveLength(0);

    const entries = context.activityLog.entries();
    expect(entries.map((e) => e.event)).toEqual(['failed']);
    expect(entries[0]).toMatchObject({ tool: CLEAR_TOOL, reasoning: REASON });
    expect(entries[0]!.error).toMatch(/^clear: transaction: Simulation failed/);
    expect(entries[0]!.tx).toBeUndefined();
  });

  it('never writes the secret key to the log or the response', async () => {
    const rpc = ours();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    const { text } = await callClear(client, { reasoning: REASON });
    const secret = bs58.encode(us.secretKey);
    expect(text).not.toContain(secret);
    expect(JSON.stringify(context.activityLog.entries())).not.toContain(secret);
    expect(warnings.join('\n')).not.toContain(secret);
  });
});
