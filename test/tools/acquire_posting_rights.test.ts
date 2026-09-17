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
import { CHUNK_BYTES, COMBINED_CHUNK_BYTES } from '../../src/program/chunk.js';
import { solToLamports } from '../../src/program/math.js';
import { MockRpc } from '../../src/rpc/MockRpc.js';
import { RpcError } from '../../src/rpc/Rpc.js';
import { createContext, createServer, type ServerContext } from '../../src/server.js';
import {
  ACQUIRE_TOOL,
  acquireOutputShape,
  planAcquire,
  type AcquireOutput,
} from '../../src/tools/acquire_posting_rights.js';
import { READ_BILLBOARD_TOOL, type ReadBillboardOutput } from '../../src/tools/read_billboard.js';

const us = Keypair.generate();
const them = Keypair.generate();
const sol = (s: string) => solToLamports(s);
const T0 = new Date('2026-09-14T12:00:00.000Z');

let dir: string;
let warnings: string[];
const open: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-acquire-'));
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

async function callAcquire(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: ACQUIRE_TOOL, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === 'text')?.text ?? '';
  return { result, text, structured: result.structuredContent as AcquireOutput | undefined };
}

async function callRead(client: Client): Promise<ReadBillboardOutput> {
  const result = await client.callTool({ name: READ_BILLBOARD_TOOL, arguments: {} });
  return result.structuredContent as ReadBillboardOutput;
}

function seeded(message = 'theirs'): MockRpc {
  return new MockRpc({ poster: them.publicKey, amount: sol('0.1'), message });
}

const REASON = 'The slot is worth 0.101 SOL to us this week: lunch special launches Monday.';

describe('acquire_posting_rights registration', () => {
  it('is listed with input and output schemas', async () => {
    const { client } = await connect(makeContext(seeded()));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === ACQUIRE_TOOL);
    expect(tool).toBeDefined();
    const input = tool!.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(input.properties).sort()).toEqual([
      'bid_sol',
      'dry_run',
      'message',
      'reasoning',
    ]);
    expect(input.required).toEqual(['reasoning']);
    const output = (tool!.outputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(output).sort()).toEqual(Object.keys(acquireOutputShape).sort());
  });

  it('rejects an empty or blank reasoning and a bid with more than 9 decimals', async () => {
    const rpc = seeded();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);

    for (const reasoning of ['', '   ']) {
      const { result, text } = await callAcquire(client, { reasoning, dry_run: true });
      expect(result.isError).toBe(true);
      expect(text).toMatch(/reasoning/);
    }
    const { result, text } = await callAcquire(client, {
      reasoning: REASON,
      bid_sol: '0.101000000001',
      dry_run: true,
    });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/bid_sol/);

    expect(rpc.billboard.message).toBe('theirs');
    expect(rpc.transactions).toHaveLength(0);
    expect(context.activityLog.entries()).toEqual([]);
  });
});

describe('planAcquire', () => {
  it('computes the spec figures for the 0.1 -> 0.101 case', () => {
    const before = seeded().billboard;
    const planned = planAcquire(before, {});
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.bid).toBe(sol('0.101'));
    expect(planned.plan.split.prevPosterReceives).toBe(sol('0.1005'));
    expect(planned.plan.split.creatorShare).toBe(sol('0.0005'));
    expect(planned.plan.outbid.nextMinimumBid).toBe(sol('0.10201'));
    expect(planned.plan.outbid.youReceive).toBe(sol('0.101505'));
    expect(planned.plan.first).toBeNull();
    expect(planned.plan.rest).toEqual([]);
  });

  it('chunks a message so the first chunk shares the acquire transaction', () => {
    const message = 'x'.repeat(2000);
    const planned = planAcquire(seeded().billboard, { message });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.first).toHaveLength(COMBINED_CHUNK_BYTES);
    expect(planned.plan.rest.map((c) => c.length)).toEqual([
      CHUNK_BYTES,
      2000 - COMBINED_CHUNK_BYTES - CHUNK_BYTES,
    ]);
    expect(planned.plan.messageBytes).toBe(2000);
  });

  it('refuses a bid below the minimum, a zero bid, and an oversized message', () => {
    const before = seeded().billboard;
    expect(planAcquire(before, { bid_sol: '0.1' })).toMatchObject({
      ok: false,
      error: 'below_minimum',
    });
    expect(planAcquire(before, { bid_sol: '0' })).toMatchObject({
      ok: false,
      error: 'invalid_bid',
    });
    expect(planAcquire(before, { message: 'y'.repeat(4097) })).toMatchObject({
      ok: false,
      error: 'message_too_long',
    });
    expect(planAcquire(before, { message: 'y'.repeat(4096) }).ok).toBe(true);
  });

  it('requires an explicit positive bid for the first ever post', () => {
    const before = new MockRpc().billboard;
    expect(planAcquire(before, {})).toMatchObject({ ok: false, error: 'invalid_bid' });
    const planned = planAcquire(before, { bid_sol: '0.05' });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.split).toEqual({ creatorShare: sol('0.05'), prevPosterReceives: 0n });
  });
});

describe('dry_run', () => {
  it('returns the full figures and changes nothing, in write mode', async () => {
    const rpc = seeded();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);

    const { result, text, structured } = await callAcquire(client, {
      reasoning: REASON,
      message: 'hello',
      dry_run: true,
    });
    expect(result.isError).toBeFalsy();
    expect(structured).toEqual({
      status: 'dry_run',
      current_poster: them.publicKey.toBase58(),
      current_amount_sol: '0.1',
      you_are_poster: false,
      minimum_bid_sol: '0.101',
      bid_sol: '0.101',
      previous_holder_receives_sol: '0.1005',
      creator_receives_sol: '0.0005',
      if_outbid_at_minimum_you_receive_sol: '0.101505',
      limits: {
        ok: true,
        max_bid_sol: '0.2',
        daily_cap_sol: '0.5',
        spent_last_24h_sol: '0',
        remaining_today_sol: '0.5',
      },
      message_bytes: 5,
      transactions_planned: 1,
      transactions_sent: 0,
      signatures: [],
    });
    expect(text).toContain('Nothing was signed');
    expect(text).toContain('0.1005');

    expect(rpc.billboard.message).toBe('theirs');
    expect(rpc.billboard.poster.equals(them.publicKey)).toBe(true);
    expect(rpc.transactions).toHaveLength(0);
    expect(context.activityLog.entries()).toEqual([]);
  });

  it('works in read-only mode with limits reported as null', async () => {
    const rpc = seeded();
    const context = makeContext(rpc);
    const { client } = await connect(context);
    const { result, structured } = await callAcquire(client, {
      reasoning: REASON,
      bid_sol: '0.15',
      dry_run: true,
    });
    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      status: 'dry_run',
      bid_sol: '0.15',
      minimum_bid_sol: '0.101',
      previous_holder_receives_sol: '0.125',
      creator_receives_sol: '0.025',
      limits: null,
    });
    expect(rpc.transactions).toHaveLength(0);
  });

  it('reports a bid over the limit as not ok without logging a refusal', async () => {
    const context = makeContext(seeded(), autoEnv);
    const { client } = await connect(context);
    const { structured } = await callAcquire(client, {
      reasoning: REASON,
      bid_sol: '0.201',
      dry_run: true,
    });
    expect(structured!.status).toBe('dry_run');
    expect(structured!.limits).toMatchObject({ ok: false, reason: 'max_bid' });
    expect(context.activityLog.entries()).toEqual([]);
  });
});

describe('refusals before any signing', () => {
  it('refuses a bid above MAX_BID_SOL, logs refused_limit, leaves chain state untouched', async () => {
    const rpc = seeded();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);

    const { result, structured } = await callAcquire(client, {
      reasoning: REASON,
      bid_sol: '0.201',
      message: 'ours',
    });
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      status: 'refused',
      error: 'limit_exceeded',
      bid_sol: '0.201',
      limits: { ok: false, reason: 'max_bid', max_bid_sol: '0.2' },
      transactions_sent: 0,
      signatures: [],
    });
    expect(structured!.reason).toMatch(/MAX_BID_SOL/);

    expect(rpc.transactions).toHaveLength(0);
    expect(rpc.billboard.message).toBe('theirs');
    expect(rpc.billboard.amount).toBe(sol('0.1'));

    const entries = context.activityLog.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: 'refused_limit',
      tool: ACQUIRE_TOOL,
      reasoning: REASON,
      bid_sol: '0.201',
      billboard_before: { poster: them.publicKey.toBase58(), amount_sol: '0.1' },
    });
    expect(entries[0]!.error).toMatch(/^limit_exceeded: max_bid/);
    expect(entries[0]!.tx).toBeUndefined();
  });

  it('refuses when the daily cap would be exceeded, counting earlier executed bids', async () => {
    const rpc = seeded();
    const context = makeContext(rpc, { ...autoEnv, DAILY_CAP_SOL: '0.3' });
    context.activityLog.append({
      event: 'executed',
      tool: ACQUIRE_TOOL,
      reasoning: 'earlier',
      bid_sol: '0.15',
      tx: 'earlier-sig',
    });
    const { client } = await connect(context);
    const { structured } = await callAcquire(client, { reasoning: REASON, bid_sol: '0.16' });
    expect(structured).toMatchObject({
      status: 'refused',
      error: 'limit_exceeded',
      limits: {
        ok: false,
        reason: 'daily_cap',
        spent_last_24h_sol: '0.15',
        remaining_today_sol: '0.15',
      },
    });
    expect(rpc.transactions).toHaveLength(0);
    expect(context.activityLog.entries().map((e) => e.event)).toEqual([
      'executed',
      'refused_limit',
    ]);
  });

  it('refuses a below-minimum bid and an oversized message without logging', async () => {
    const rpc = seeded();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);

    let { result, structured } = await callAcquire(client, { reasoning: REASON, bid_sol: '0.1' });
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({ status: 'refused', error: 'below_minimum', bid_sol: '0.1' });
    expect(structured!.reason).toMatch(/6000/);

    ({ result, structured } = await callAcquire(client, {
      reasoning: REASON,
      message: 'z'.repeat(4097),
    }));
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      status: 'refused',
      error: 'message_too_long',
      message_bytes: 4097,
    });

    expect(rpc.transactions).toHaveLength(0);
    expect(context.activityLog.entries()).toEqual([]);
  });

  it('returns a clear read-only error when no keypair is configured', async () => {
    const rpc = seeded();
    const { client } = await connect(makeContext(rpc));
    const { result, text, structured } = await callAcquire(client, { reasoning: REASON });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/read-only mode/);
    expect(text).toMatch(/BILLBOARD_KEYPAIR/);
    expect(structured).toBeUndefined();
    expect(rpc.transactions).toHaveLength(0);
  });

  it('returns a proposal with the dry-run figures in propose mode and signs nothing', async () => {
    const rpc = seeded();
    const context = makeContext(rpc, writeEnv);
    const { client } = await connect(context);
    const { result, text, structured } = await callAcquire(client, {
      reasoning: REASON,
      message: 'proposed message',
    });
    expect(result.isError).toBeUndefined();
    expect(structured?.status).toBe('proposed');
    expect(structured?.proposal_id).toMatch(/^prop_[0-9a-f]{12}$/);
    expect(structured?.expires_at).toBe(new Date(T0.getTime() + 60 * 60 * 1000).toISOString());
    expect(structured?.bid_sol).toBe('0.101');
    expect(structured?.previous_holder_receives_sol).toBe('0.1005');
    expect(structured?.creator_receives_sol).toBe('0.0005');
    expect(structured?.limits?.ok).toBe(true);
    expect(structured?.transactions_planned).toBe(1);
    expect(structured?.signatures).toEqual([]);
    expect(text).toMatch(/approve_proposal/);
    expect(text).toMatch(/AUTO_BID=false/);
    expect(rpc.transactions).toHaveLength(0);
    expect(rpc.billboard.poster.equals(them.publicKey)).toBe(true);

    const entries = context.activityLog.entries();
    expect(entries.map((e) => e.event)).toEqual(['proposed']);
    expect(entries[0]).toMatchObject({
      tool: ACQUIRE_TOOL,
      reasoning: REASON,
      proposal_id: structured?.proposal_id,
      bid_sol: '0.101',
      billboard_before: { poster: them.publicKey.toBase58(), amount_sol: '0.1' },
    });
    expect(context.proposals.pendingCount).toBe(1);
  });

  it('checks limits before proposing, so an over-limit bid is refused rather than parked', async () => {
    const rpc = seeded();
    const context = makeContext(rpc, writeEnv);
    const { client } = await connect(context);
    const { result, structured } = await callAcquire(client, { reasoning: REASON, bid_sol: '0.3' });
    expect(result.isError).toBe(true);
    expect(structured?.status).toBe('refused');
    expect(structured?.error).toBe('limit_exceeded');
    expect(context.activityLog.entries().map((e) => e.event)).toEqual(['refused_limit']);
    expect(context.proposals.pendingCount).toBe(0);
  });
});

describe('execution under AUTO_BID=true', () => {
  it('acquires at the minimum with a short message in one transaction', async () => {
    const rpc = seeded('old message');
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);

    const { result, text, structured } = await callAcquire(client, {
      reasoning: REASON,
      message: 'new message',
    });
    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      status: 'executed',
      bid_sol: '0.101',
      previous_holder_receives_sol: '0.1005',
      creator_receives_sol: '0.0005',
      transactions_planned: 1,
      transactions_sent: 1,
      billboard_after: {
        poster: us.publicKey.toBase58(),
        amount_sol: '0.101',
        message_bytes: 11,
        you_are_poster: true,
      },
    });
    expect(structured!.error).toBeUndefined();
    expect(structured!.signatures).toHaveLength(1);
    expect(text).toMatch(/Acquired the slot at 0.101 SOL/);

    expect(rpc.transactions).toHaveLength(1);
    expect(rpc.billboard.poster.equals(us.publicKey)).toBe(true);
    expect(rpc.billboard.amount).toBe(sol('0.101'));
    expect(rpc.billboard.message).toBe('new message');
    expect(rpc.transfers.map((t) => [t.to.toBase58(), t.lamports])).toEqual([
      [rpc.billboard.creator.toBase58(), sol('0.0005')],
      [them.publicKey.toBase58(), sol('0.1005')],
    ]);

    const entries = context.activityLog.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: 'executed',
      tool: ACQUIRE_TOOL,
      reasoning: REASON,
      bid_sol: '0.101',
      tx: structured!.signatures[0],
      billboard_before: { poster: them.publicKey.toBase58(), amount_sol: '0.1' },
      billboard_after: { poster: us.publicKey.toBase58(), amount_sol: '0.101' },
    });

    // The spend limiter now counts the gross bid once.
    const read = await callRead(client);
    expect(read.you_are_poster).toBe(true);
    expect(read.message).toBe('new message');
    expect(read.changed_since_last_read).toBe(true);
    expect(read.operator.limits.spent_last_24h_sol).toBe('0.101');
    expect(read.operator.limits.remaining_today_sol).toBe('0.399');
  });

  it('sends a 2000-byte message as acquire+chunk then two appends, logging each transaction', async () => {
    const rpc = seeded();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    const message = Array.from({ length: 2000 }, (_, i) => String(i % 10)).join('');

    const { result, structured } = await callAcquire(client, {
      reasoning: REASON,
      bid_sol: '0.15',
      message,
    });
    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      status: 'executed',
      transactions_planned: 3,
      transactions_sent: 3,
      billboard_after: { message_bytes: 2000, you_are_poster: true },
    });
    expect(structured!.signatures).toHaveLength(3);
    expect(rpc.transactions.map((t) => t.signature)).toEqual(structured!.signatures);
    expect(rpc.billboard.message).toBe(message);
    expect(rpc.billboard.amount).toBe(sol('0.15'));

    const entries = context.activityLog.entries();
    expect(entries.map((e) => e.event)).toEqual(['executed', 'executed', 'executed']);
    expect(entries.map((e) => e.bid_sol)).toEqual(['0.15', undefined, undefined]);
    expect(entries.map((e) => e.tx)).toEqual(structured!.signatures);
    expect(entries.every((e) => e.reasoning === REASON)).toBe(true);
    expect(context.limits!.spentLast24h()).toBe(sol('0.15'));
  });

  it('reports a mid-sequence chunk failure with how many transactions landed', async () => {
    const rpc = seeded();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    const message = 'm'.repeat(2000);

    // Fail the second send: MockRpc notifies listeners synchronously after
    // each commit, so arm the failure once the first transaction has landed.
    let landed = 0;
    rpc.onAccountChange(context.reader.address, () => {
      landed += 1;
      if (landed === 1) {
        rpc.failNextSend(
          new RpcError('Simulation failed: blockhash not found', { kind: 'transaction' }),
        );
      }
    });

    const { result, text, structured } = await callAcquire(client, { reasoning: REASON, message });
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      status: 'executed',
      error: 'transaction_failed',
      transactions_planned: 3,
      transactions_sent: 1,
      billboard_after: { message_bytes: COMBINED_CHUNK_BYTES, you_are_poster: true },
    });
    expect(structured!.signatures).toHaveLength(1);
    expect(structured!.reason).toMatch(/1 of 3 transactions landed/);
    expect(structured!.reason).toMatch(/transaction 2 failed/);
    expect(structured!.reason).toMatch(/append_message/);
    expect(text).toMatch(/Partially executed/);

    expect(rpc.transactions).toHaveLength(1);
    expect(rpc.billboard.poster.equals(us.publicKey)).toBe(true);
    expect(rpc.billboard.message).toBe('m'.repeat(COMBINED_CHUNK_BYTES));

    const entries = context.activityLog.entries();
    expect(entries.map((e) => e.event)).toEqual(['executed', 'failed']);
    expect(entries[0]!.bid_sol).toBe('0.101');
    expect(entries[1]).toMatchObject({ tool: ACQUIRE_TOOL, reasoning: REASON });
    expect(entries[1]!.error).toMatch(/append chunk 2 of 3/);
    expect(entries[1]!.error).toMatch(/blockhash not found/);
    expect(entries[1]!.bid_sol).toBeUndefined();
  });

  it('reports a failed acquire transaction as failed with nothing landed', async () => {
    const rpc = seeded();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);
    rpc.failNextSend(
      new RpcError('Simulation failed: custom program error: 0x1770', {
        kind: 'transaction',
        programError: 6000,
      }),
    );

    const { result, structured } = await callAcquire(client, { reasoning: REASON, message: 'x' });
    expect(result.isError).toBe(true);
    expect(structured).toMatchObject({
      status: 'failed',
      error: 'transaction_failed',
      transactions_sent: 0,
      signatures: [],
      billboard_after: { poster: them.publicKey.toBase58(), you_are_poster: false },
    });
    expect(structured!.reason).toMatch(/nothing landed/);
    expect(structured!.reason).toMatch(/6000 \(Amount\)/);

    expect(rpc.transactions).toHaveLength(0);
    expect(rpc.billboard.message).toBe('theirs');
    const entries = context.activityLog.entries();
    expect(entries.map((e) => e.event)).toEqual(['failed']);
    expect(entries[0]).toMatchObject({ bid_sol: '0.101', reasoning: REASON });
    expect(entries[0]!.tx).toBeUndefined();
    expect(context.limits!.spentLast24h()).toBe(0n);
  });

  it('makes the first ever post with an explicit bid, everything to the creator', async () => {
    const rpc = new MockRpc();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);

    let { structured } = await callAcquire(client, { reasoning: REASON, message: 'first' });
    expect(structured).toMatchObject({ status: 'refused', error: 'invalid_bid' });

    ({ structured } = await callAcquire(client, {
      reasoning: REASON,
      bid_sol: '0.05',
      message: 'first',
    }));
    expect(structured).toMatchObject({
      status: 'executed',
      previous_holder_receives_sol: '0',
      creator_receives_sol: '0.05',
      billboard_after: { amount_sol: '0.05', message_bytes: 5, you_are_poster: true },
    });
    expect(rpc.transfers).toHaveLength(1);
    expect(rpc.transfers[0]!.to.equals(rpc.billboard.creator)).toBe(true);
  });

  it('lets outbid detection see the slot we just took', async () => {
    const rpc = seeded();
    const context = makeContext(rpc, autoEnv);
    const { client } = await connect(context);

    await callAcquire(client, { reasoning: REASON, message: 'ours' });
    await rpc.acquireAs(them, sol('0.2'), 'theirs again');

    const read = await callRead(client);
    expect(read.you_are_poster).toBe(false);
    expect(read.changed_since_last_read).toBe(true);
    expect(context.activityLog.entries().map((e) => e.event)).toEqual([
      'executed',
      'outbid_detected',
    ]);
  });

  it('never writes to stdout and never mentions the secret', async () => {
    const secret = writeEnv.BILLBOARD_KEYPAIR;
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let context: ServerContext;
    try {
      context = makeContext(seeded(), autoEnv);
      const { client } = await connect(context);
      const { text, structured } = await callAcquire(client, {
        reasoning: REASON,
        message: 'ours',
      });
      expect(text).not.toContain(secret);
      expect(JSON.stringify(structured)).not.toContain(secret);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks).toEqual([]);
    expect(warnings).toEqual([]);
    const raw = JSON.stringify(context!.activityLog.entries());
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(us.secretKey.join(','));
  });
});
