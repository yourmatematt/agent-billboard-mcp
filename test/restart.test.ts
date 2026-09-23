/**
 * Reader state across restarts: what a heartbeat host sees.
 *
 * A scheduled agent gets a fresh server process on every wake. Each "process"
 * here is a fresh context and server built from the same working directory,
 * talking to the same MockRpc (the chain outlives the process). Between
 * processes the only thing carried over is what is on disk.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BillboardReader } from '../src/billboard/reader.js';
import { READER_STATE_VERSION, ReaderStateStore } from '../src/billboard/state.js';
import { DEFAULT_STATE_PATH, loadConfig } from '../src/config.js';
import { BILLBOARD_ADDRESS, PROGRAM_ID, type BillboardState } from '../src/program/layout.js';
import { solToLamports } from '../src/program/math.js';
import { MockRpc } from '../src/rpc/MockRpc.js';
import { createSandboxRpc } from '../src/sandbox.js';
import { createContext, createServer, type ServerContext } from '../src/server.js';
import { READ_BILLBOARD_TOOL, type ReadBillboardOutput } from '../src/tools/read_billboard.js';

const us = Keypair.generate();
const other = Keypair.generate();
const rival = Keypair.generate();
const T0 = new Date('2026-09-23T09:00:00.000Z');
const sol = (s: string) => solToLamports(s);

let dir: string;
let open: Array<() => Promise<void>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-restart-'));
  open = [];
});
afterEach(async () => {
  while (open.length > 0) await open.pop()!();
  rmSync(dir, { recursive: true, force: true });
});

interface Process {
  context: ServerContext;
  read: () => Promise<ReadBillboardOutput>;
  warnings: string[];
}

/** Starts one server "process" in `dir`, as `claude -p` would on a wake. */
async function start(
  rpc: MockRpc,
  env: Record<string, string> = {
    BILLBOARD_KEYPAIR: bs58.encode(us.secretKey),
    MAX_BID_SOL: '0.2',
  },
): Promise<Process> {
  const config = loadConfig(env, { cwd: dir, dotenvPath: null });
  const warnings: string[] = [...config.warnings];
  const context = createContext(config, rpc, { now: () => T0, warn: (m) => warnings.push(m) });
  const server = createServer(context);
  const client = new Client({ name: 'restart-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  const read = async (): Promise<ReadBillboardOutput> => {
    const result = await client.callTool({ name: READ_BILLBOARD_TOOL, arguments: {} });
    return result.structuredContent as unknown as ReadBillboardOutput;
  };
  return { context, read, warnings };
}

const statePath = () => join(dir, 'billboard-state.json');
const outbids = (p: Process) =>
  p.context.activityLog.entries().filter((e) => e.event === 'outbid_detected');

describe('persisted reader state, across server processes', () => {
  it('first read ever: first_read true, changed_since_last_read true, state file written', async () => {
    const rpc = new MockRpc({ poster: other.publicKey, amount: sol('0.1'), message: 'hello' });
    const p = await start(rpc);
    const r = await p.read();
    expect(r.first_read).toBe(true);
    expect(r.changed_since_last_read).toBe(true);
    expect(existsSync(statePath())).toBe(true);
    expect(p.context.config.statePath).toBe(join(dir, 'billboard-state.json'));
    expect(p.warnings).toEqual([]);
  });

  it('restart with no change: first_read false, changed_since_last_read false', async () => {
    const rpc = new MockRpc({ poster: other.publicKey, amount: sol('0.1'), message: 'hello' });
    await (await start(rpc)).read();
    const second = await start(rpc);
    const r = await second.read();
    expect(r.first_read).toBe(false);
    expect(r.changed_since_last_read).toBe(false);
    expect(second.warnings).toEqual([]);
  });

  it('an outside acquire between restarts is a change, and the outbid is logged exactly once', async () => {
    const rpc = new MockRpc({ poster: us.publicKey, amount: sol('0.1'), message: 'ours' });

    // Wake 1: we hold the board. Nothing to log.
    const wake1 = await start(rpc);
    expect((await wake1.read()).you_are_poster).toBe(true);
    expect(outbids(wake1)).toHaveLength(0);

    // Between wakes nothing of ours runs, and a rival takes the board.
    await rpc.acquireAs(rival, sol('0.2'), 'theirs now');

    // Wake 2: a fresh process sees the move and logs the outbid once.
    const wake2 = await start(rpc);
    const r2 = await wake2.read();
    expect(r2.first_read).toBe(false);
    expect(r2.changed_since_last_read).toBe(true);
    expect(r2.you_are_poster).toBe(false);
    const logged = outbids(wake2);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.billboard_before).toMatchObject({ poster: us.publicKey.toBase58() });
    expect(logged[0]!.billboard_after).toMatchObject({
      poster: rival.publicKey.toBase58(),
      amount_sol: '0.2',
    });
    // A second read in the same wake does not log it again.
    await wake2.read();
    expect(outbids(wake2)).toHaveLength(1);

    // Wake 3: the same flip is not reported again by a later process.
    const wake3 = await start(rpc);
    const r3 = await wake3.read();
    expect(r3.changed_since_last_read).toBe(false);
    expect(outbids(wake3)).toHaveLength(1);
  });

  it('a different wallet in the same folder is treated as a first read', async () => {
    const rpc = new MockRpc({ poster: other.publicKey, amount: sol('0.1'), message: 'hello' });
    await (await start(rpc)).read();

    const swapped = await start(rpc, {
      BILLBOARD_KEYPAIR: bs58.encode(other.secretKey),
      MAX_BID_SOL: '0.2',
    });
    const r = await swapped.read();
    expect(r.first_read).toBe(true);
    expect(r.changed_since_last_read).toBe(true);
    expect(swapped.warnings.join('\n')).toMatch(/different program, billboard or wallet/);
    // The next write replaced the file, so the new wallet's next process is not a first read.
    const file = JSON.parse(readFileSync(statePath(), 'utf8')) as { wallet: string };
    expect(file.wallet).toBe(other.publicKey.toBase58());

    // Read-only in the same folder is a different identity again (wallet null).
    const readOnly = await start(rpc, {});
    expect((await readOnly.read()).first_read).toBe(true);
  });

  it('a corrupt state file is a first read plus a warning, never a crash, and is replaced', async () => {
    const rpc = new MockRpc({ poster: other.publicKey, amount: sol('0.1'), message: 'hello' });
    writeFileSync(statePath(), '{ this is not json');
    const p = await start(rpc);
    const r = await p.read();
    expect(r.first_read).toBe(true);
    expect(r.changed_since_last_read).toBe(true);
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]).toMatch(/could not be read.*first read/);

    const next = await start(rpc);
    expect((await next.read()).first_read).toBe(false);
    expect(next.warnings).toEqual([]);
  });

  it('a well-formed file in the wrong shape is also a first read plus a warning', async () => {
    const rpc = new MockRpc({ poster: other.publicKey, amount: sol('0.1') });
    writeFileSync(statePath(), JSON.stringify({ version: 99 }));
    const p = await start(rpc);
    expect((await p.read()).first_read).toBe(true);
    expect(p.warnings.join('\n')).toMatch(/not in the expected format/);
  });

  it('STATE_PATH is resolved against the working directory', async () => {
    const rpc = new MockRpc({ poster: other.publicKey, amount: sol('0.1') });
    const p = await start(rpc, {
      BILLBOARD_KEYPAIR: bs58.encode(us.secretKey),
      MAX_BID_SOL: '0.2',
      STATE_PATH: './nested-state.json',
    });
    await p.read();
    expect(p.context.config.statePath).toBe(join(dir, 'nested-state.json'));
    expect(existsSync(join(dir, 'nested-state.json'))).toBe(true);
    expect(existsSync(statePath())).toBe(false);
    expect(DEFAULT_STATE_PATH).toBe('./billboard-state.json');
  });
});

describe('the sandbox never persists', () => {
  it('writes no state file, ignores STATE_PATH with a warning, and starts fresh every process', async () => {
    const env = { BILLBOARD_SANDBOX: 'true', STATE_PATH: './sandbox-state.json' };
    const first = await start(await createSandboxRpc('default'), env);
    expect(first.context.config.statePath).toBeNull();
    expect(first.warnings.join('\n')).toMatch(/STATE_PATH is ignored/);
    const r1 = await first.read();
    expect(r1.sandbox).toBe(true);
    expect(r1.first_read).toBe(true);
    expect(r1.changed_since_last_read).toBe(true);
    expect((await first.read()).first_read).toBe(false);

    const second = await start(await createSandboxRpc('default'), env);
    expect((await second.read()).first_read).toBe(true);

    expect(existsSync(join(dir, 'sandbox-state.json'))).toBe(false);
    expect(existsSync(statePath())).toBe(false);
    expect(existsSync(join(dir, 'billboard-sandbox-state.json'))).toBe(false);
  });
});

describe('ReaderStateStore', () => {
  const identity = {
    programId: PROGRAM_ID.toBase58(),
    billboard: BILLBOARD_ADDRESS.toBase58(),
    wallet: us.publicKey.toBase58(),
  };
  const state = (message: string, amount: bigint): BillboardState => ({
    creator: other.publicKey,
    poster: rival.publicKey,
    amount,
    message,
    messageBytes: Buffer.byteLength(message, 'utf8'),
  });

  it('round-trips states losslessly: large lamports, multi-byte text, nulls', () => {
    const warnings: string[] = [];
    const store = new ReaderStateStore(statePath(), identity, {
      now: () => T0,
      warn: (m) => warnings.push(m),
    });
    const seen = state('Émoji 🪧 and "quotes"\nnewline', 18_446_744_073_709_551_615n);
    store.save({ lastSeen: seen, lastObserved: null });
    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.lastObserved).toBeNull();
    const back = loaded!.lastSeen!;
    expect(back.amount).toBe(seen.amount);
    expect(back.message).toBe(seen.message);
    expect(back.messageBytes).toBe(seen.messageBytes);
    expect(back.poster.equals(seen.poster)).toBe(true);
    expect(back.creator.equals(seen.creator)).toBe(true);

    const file = JSON.parse(readFileSync(statePath(), 'utf8')) as Record<string, unknown>;
    expect(file).toMatchObject({
      version: READER_STATE_VERSION,
      program_id: identity.programId,
      billboard: identity.billboard,
      wallet: identity.wallet,
      last_observed: null,
      updated_at: T0.toISOString(),
    });
    expect((file['last_seen'] as Record<string, unknown>)['amount_lamports']).toBe(
      '18446744073709551615',
    );
    expect(warnings).toEqual([]);
  });

  it('leaves no temp file behind after a write', () => {
    const store = new ReaderStateStore(statePath(), identity, { warn: () => {} });
    store.save({ lastSeen: state('x', 1n), lastObserved: state('x', 1n) });
    store.save({ lastSeen: state('y', 2n), lastObserved: state('y', 2n) });
    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect(store.load()!.lastSeen!.message).toBe('y');
  });

  it('ignores a file for another program or billboard', () => {
    new ReaderStateStore(statePath(), { ...identity, programId: other.publicKey.toBase58() }).save({
      lastSeen: state('x', 1n),
      lastObserved: null,
    });
    const warnings: string[] = [];
    const store = new ReaderStateStore(statePath(), identity, { warn: (m) => warnings.push(m) });
    expect(store.load()).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('an unwritable path warns once and does not throw', () => {
    const warnings: string[] = [];
    const store = new ReaderStateStore(join(dir, 'missing-dir', 'state.json'), identity, {
      warn: (m) => warnings.push(m),
    });
    expect(() => store.save({ lastSeen: state('x', 1n), lastObserved: null })).not.toThrow();
    expect(() => store.save({ lastSeen: state('y', 2n), lastObserved: null })).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not write reader state file/);
  });

  it('seeds a BillboardReader so the first read of a new process compares against the file', async () => {
    const rpc = new MockRpc({ poster: us.publicKey, amount: sol('0.1'), message: 'ours' });
    const mk = () =>
      new BillboardReader(rpc, {
        wallet: us.publicKey,
        store: new ReaderStateStore(statePath(), identity, { warn: () => {} }),
      });
    expect((await mk().read()).firstRead).toBe(true);
    const again = await mk().read();
    expect(again.firstRead).toBe(false);
    expect(again.changedSinceLastRead).toBe(false);
  });
});
