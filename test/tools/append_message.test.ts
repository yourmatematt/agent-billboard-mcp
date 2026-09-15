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
import { CHUNK_BYTES, messageByteLength } from '../../src/program/chunk.js';
import { MESSAGE_SIZE } from '../../src/program/layout.js';
import { solToLamports } from '../../src/program/math.js';
import { MockRpc } from '../../src/rpc/MockRpc.js';
import { RpcError } from '../../src/rpc/Rpc.js';
import { createContext, createServer, type ServerContext } from '../../src/server.js';
import {
  APPEND_TOOL,
  appendOutputShape,
  planAppend,
  type AppendOutput,
} from '../../src/tools/append_message.js';
import { READ_BILLBOARD_TOOL, type ReadBillboardOutput } from '../../src/tools/read_billboard.js';

const us = Keypair.generate();
const them = Keypair.generate();
const sol = (s: string) => solToLamports(s);
const T0 = new Date('2026-09-14T12:00:00.000Z');

let dir: string;
let warnings: string[];
const open: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-append-'));
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

async function callAppend(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: APPEND_TOOL, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === 'text')?.text ?? '';
  return { result, text, structured: result.structuredContent as AppendOutput | undefined };
}

async function callRead(client: Client): Promise<ReadBillboardOutput> {
  const result = await client.callTool({ name: READ_BILLBOARD_TOOL, arguments: {} });
  return result.structuredContent as ReadBillboardOutput;
}

/** The wallet under test holds the slot. */
function ours(message = 'ours: '): MockRpc {
  return new MockRpc({ poster: us.publicKey, amount: sol('0.101'), message });
}

/** Someone else holds the slot. */
function theirs(message = 'theirs'): MockRpc {
  return new MockRpc({ poster: them.publicKey, amount: sol('0.1'), message });
}

const REASON = 'Adding the opening hours the operator asked for in intent.md.';

describe('append_message registration', () => {
  it('is listed with input and output schemas', async () => {
    const { client } = await connect(makeContext(ours()));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === APPEND_TOOL);
    expect(tool).toBeDefined();
    const input = tool!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(input.properties).sort()).toEqual(['message', 'reasoning']);
    expect(input.required?.sort()).toEqual(['message', 'reasoning']);
    const output = (tool!.outputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(output).sort()).toEqual(Object.keys(appendOutputShape).sort());
  });

  it('rejects an empty or blank reasoning and an empty message before touching anything', async () => {
    const rpc = ours();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);

    for (const reasoning of ['', '   ']) {
      const { result, text } = await callAppend(client, { reasoning, message: 'x' });
      expect(result.isError).toBe(true);
      expect(text).toMatch(/reasoning/);
    }
    const { result, text } = await callAppend(client, { reasoning: REASON, message: '' });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/message/);

    expect(rpc.billboard.message).toBe('ours: ');
    expect(rpc.transactions).toHaveLength(0);
    expect(context.activityLog.entries()).toEqual([]);
  });
});

describe('planAppend', () => {
  it('refuses when the wallet is not the poster', () => {
    const planned = planAppend(theirs().billboard, 'hello', false);
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error).toBe('not_poster');
    expect(planned.reason).toContain(them.publicKey.toBase58());
  });

  it('counts existing bytes against the 4096-byte cap', () => {
    const existing = 'é'.repeat(2000); // 4000 bytes, 2000 characters
    const before = ours(existing).billboard;
    expect(before.messageBytes).toBe(4000);

    const tooLong = planAppend(before, 'a'.repeat(97), true);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.error).toBe('message_too_long');
      expect(tooLong.reason).toMatch(/4000 bytes/);
      expect(tooLong.reason).toMatch(/97 bytes/);
      expect(tooLong.reason).toMatch(/4097 bytes/);
      expect(tooLong.reason).toMatch(/At most 96 more bytes/);
    }

    const exact = planAppend(before, 'a'.repeat(96), true);
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.plan.messageBytes).toBe(96);
      expect(exact.plan.chunks).toEqual(['a'.repeat(96)]);
    }
  });

  it('chunks at 900 bytes on UTF-8 boundaries', () => {
    const message = '🙂'.repeat(500); // 2000 bytes, never splittable mid-code-point
    const planned = planAppend(ours().billboard, message, true);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.chunks).toHaveLength(3);
    for (const chunk of planned.plan.chunks) {
      expect(messageByteLength(chunk)).toBeLessThanOrEqual(CHUNK_BYTES);
      expect(chunk).toMatch(/^(🙂)+$/u);
    }
    expect(planned.plan.chunks.join('')).toBe(message);
  });
});

describe('refusals before any signing', () => {
  it('refuses a non-poster, logs refused_not_poster, sends nothing', async () => {
    const rpc = theirs();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);

    const { result, text, structured } = await callAppend(client, {
      reasoning: REASON,
      message: 'hello',
    });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/^Refused \(not_poster\)/);
    expect(structured).toMatchObject({
      status: 'refused',
      error: 'not_poster',
      current_poster: them.publicKey.toBase58(),
      current_amount_sol: '0.1',
      you_are_poster: false,
      existing_bytes: 6,
      message_bytes: 5,
      total_bytes_after: 11,
      transactions_planned: 0,
      transactions_sent: 0,
      signatures: [],
    });

    expect(rpc.transactions).toHaveLength(0);
    expect(rpc.billboard.message).toBe('theirs');
    const entries = context.activityLog.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: 'refused_not_poster',
      tool: APPEND_TOOL,
      reasoning: REASON,
      billboard_before: { poster: them.publicKey.toBase58(), amount_sol: '0.1' },
    });
    expect(entries[0]!.error).toMatch(/^not_poster:/);
    expect(entries[0]!.tx).toBeUndefined();
    expect(entries[0]!.bid_sol).toBeUndefined();
  });

  it('refuses a message that would exceed 4096 bytes with the existing text, without logging', async () => {
    const rpc = ours('x'.repeat(4000));
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);

    const { result, structured } = await callAppend(client, {
      reasoning: REASON,
      message: 'y'.repeat(97),
    });
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      status: 'refused',
      error: 'message_too_long',
      you_are_poster: true,
      existing_bytes: 4000,
      message_bytes: 97,
      total_bytes_after: 4097,
    });
    expect(rpc.transactions).toHaveLength(0);
    expect(rpc.billboard.messageBytes).toBe(4000);
    expect(context.activityLog.entries()).toEqual([]);
  });

  it('returns a clear read-only error when no keypair is configured', async () => {
    const rpc = ours();
    const context = makeContext(rpc);
    const { client } = await connect(context);
    const { result, text } = await callAppend(client, { reasoning: REASON, message: 'hello' });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/read-only mode/);
    expect(text).toMatch(/BILLBOARD_KEYPAIR/);
    expect(rpc.transactions).toHaveLength(0);
    expect(context.activityLog.entries()).toEqual([]);
  });

  it('returns a proposal in propose mode and signs nothing', async () => {
    const rpc = ours();
    const context = makeContext(rpc, writeEnv);
    const { client } = await connect(context);
    const { result, text, structured } = await callAppend(client, {
      reasoning: REASON,
      message: 'hello',
    });
    expect(result.isError).toBeUndefined();
    expect(structured?.status).toBe('proposed');
    expect(structured?.proposal_id).toMatch(/^prop_[0-9a-f]{12}$/);
    expect(structured?.expires_at).toBe(new Date(T0.getTime() + 10 * 60 * 1000).toISOString());
    expect(structured?.message_bytes).toBe(5);
    expect(structured?.total_bytes_after).toBe(messageByteLength('ours: ') + 5);
    expect(structured?.transactions_planned).toBe(1);
    expect(structured?.signatures).toEqual([]);
    expect(text).toMatch(/approve_proposal/);
    expect(rpc.transactions).toHaveLength(0);
    expect(rpc.billboard.message).toBe('ours: ');

    const entries = context.activityLog.entries();
    expect(entries.map((e) => e.event)).toEqual(['proposed']);
    expect(entries[0]).toMatchObject({
      tool: APPEND_TOOL,
      reasoning: REASON,
      proposal_id: structured?.proposal_id,
    });
    expect(entries[0]?.bid_sol).toBeUndefined();
  });

  it('still refuses a non-poster in propose mode without creating a proposal', async () => {
    const rpc = theirs();
    const context = makeContext(rpc, writeEnv);
    const { client } = await connect(context);
    const { result, structured } = await callAppend(client, { reasoning: REASON, message: 'x' });
    expect(result.isError).toBe(true);
    expect(structured?.error).toBe('not_poster');
    expect(context.activityLog.entries().map((e) => e.event)).toEqual(['refused_not_poster']);
    expect(context.proposals.pendingCount).toBe(0);
  });
});

describe('execution under AUTO_BID=true', () => {
  it('appends a short message in one transaction and logs it without bid_sol', async () => {
    const rpc = ours();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    await callRead(client);

    const { result, text, structured } = await callAppend(client, {
      reasoning: REASON,
      message: 'open 7–3 daily',
    });
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/^Appended 16 bytes in 1 transaction\(s\); message is now 22 bytes\./);
    expect(structured).toMatchObject({
      status: 'executed',
      you_are_poster: true,
      existing_bytes: 6,
      message_bytes: 16,
      total_bytes_after: 22,
      transactions_planned: 1,
      transactions_sent: 1,
      billboard_after: {
        poster: us.publicKey.toBase58(),
        amount_sol: '0.101',
        message_bytes: 22,
        you_are_poster: true,
      },
    });
    expect(structured!.error).toBeUndefined();
    expect(structured!.signatures).toHaveLength(1);

    expect(rpc.billboard.message).toBe('ours: open 7–3 daily');
    expect(rpc.billboard.poster.equals(us.publicKey)).toBe(true);
    expect(rpc.billboard.amount).toBe(sol('0.101'));
    expect(rpc.transactions).toHaveLength(1);

    const entries = context.activityLog.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: 'executed',
      tool: APPEND_TOOL,
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
    expect(after.message).toBe('ours: open 7–3 daily');
  });

  it('sends a 2000-byte message as three transactions with the final bytes correct', async () => {
    const rpc = ours('');
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    const message = 'é'.repeat(1000); // 2000 bytes: 900 + 900 + 200

    const { result, structured } = await callAppend(client, { reasoning: REASON, message });
    expect(result.isError).toBeUndefined();
    expect(structured).toMatchObject({
      status: 'executed',
      existing_bytes: 0,
      message_bytes: 2000,
      total_bytes_after: 2000,
      transactions_planned: 3,
      transactions_sent: 3,
      billboard_after: { message_bytes: 2000, you_are_poster: true },
    });
    expect(structured!.signatures).toHaveLength(3);
    expect(rpc.billboard.message).toBe(message);
    expect(rpc.billboard.messageBytes).toBe(2000);
    expect(rpc.transactions).toHaveLength(3);

    const entries = context.activityLog.entries();
    expect(entries.map((e) => e.event)).toEqual(['executed', 'executed', 'executed']);
    expect(entries.map((e) => e.tx)).toEqual(structured!.signatures);
    expect(entries.every((e) => e.reasoning === REASON && e.bid_sol === undefined)).toBe(true);
    expect(entries[0]!.billboard_before).toBeDefined();
    expect(entries[1]!.billboard_before).toBeUndefined();
    expect(entries[2]!.billboard_after).toBeDefined();
  });

  it('fills the billboard to exactly 4096 bytes', async () => {
    const rpc = ours('x'.repeat(4000));
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    const { result, structured } = await callAppend(client, {
      reasoning: REASON,
      message: 'y'.repeat(96),
    });
    expect(result.isError).toBeUndefined();
    expect(structured!.billboard_after!.message_bytes).toBe(MESSAGE_SIZE);
    expect(rpc.billboard.messageBytes).toBe(MESSAGE_SIZE);
  });

  it('stops at the first failed chunk and reports how many landed', async () => {
    const rpc = ours('');
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    const message = 'a'.repeat(2000);
    let landed = 0;
    rpc.onAccountChange(context.reader.address, () => {
      landed += 1;
      if (landed === 1) {
        rpc.failNextSend(
          new RpcError('Simulation failed: blockhash not found', { kind: 'transaction' }),
        );
      }
    });

    const { result, text, structured } = await callAppend(client, { reasoning: REASON, message });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/^Partially executed: 1 of 3 transactions landed; transaction 2 failed/);
    expect(structured).toMatchObject({
      status: 'executed',
      error: 'transaction_failed',
      transactions_planned: 3,
      transactions_sent: 1,
      billboard_after: { message_bytes: 900, you_are_poster: true },
    });
    expect(structured!.reason).toMatch(/holds 900 bytes; call append_message again/);
    expect(structured!.signatures).toHaveLength(1);
    expect(rpc.billboard.message).toBe('a'.repeat(900));
    expect(rpc.transactions).toHaveLength(1);

    const entries = context.activityLog.entries();
    expect(entries.map((e) => e.event)).toEqual(['executed', 'failed']);
    expect(entries[1]).toMatchObject({ tool: APPEND_TOOL, reasoning: REASON });
    expect(entries[1]!.error).toMatch(/^append chunk 2 of 3: transaction: Simulation failed/);
    expect(entries[1]!.tx).toBeUndefined();
  });

  it('reports a failed first chunk as failed with nothing landed', async () => {
    const rpc = ours();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    rpc.failNextSend(
      new RpcError('Simulation failed: custom program error: 0x1771', {
        kind: 'transaction',
        programError: 6001,
      }),
    );

    const { result, structured } = await callAppend(client, { reasoning: REASON, message: 'x' });
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      status: 'failed',
      error: 'transaction_failed',
      transactions_planned: 1,
      transactions_sent: 0,
      signatures: [],
      billboard_after: { message_bytes: 6 },
    });
    expect(structured!.reason).toMatch(/nothing landed/);
    expect(structured!.reason).toMatch(/6001/);
    expect(rpc.billboard.message).toBe('ours: ');

    const entries = context.activityLog.entries();
    expect(entries.map((e) => e.event)).toEqual(['failed']);
    expect(entries[0]!.error).toMatch(/^append chunk 1 of 1:/);
    expect(entries[0]!.billboard_before).toEqual({
      poster: us.publicKey.toBase58(),
      amount_sol: '0.101',
    });
  });

  it('never writes the secret key to the log or the response', async () => {
    const rpc = ours();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    const { text } = await callAppend(client, { reasoning: REASON, message: 'hello' });
    const secret = bs58.encode(us.secretKey);
    expect(text).not.toContain(secret);
    expect(JSON.stringify(context.activityLog.entries())).not.toContain(secret);
    expect(warnings.join('\n')).not.toContain(secret);
  });
});
