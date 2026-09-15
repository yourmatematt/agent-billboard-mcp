import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BillboardReader, READER_TOOL_NAME, ReaderError } from '../../src/billboard/reader.js';
import { ActivityLog } from '../../src/log/activity.js';
import { BILLBOARD_ADDRESS, BILLBOARD_ACCOUNT_DISCRIMINATOR } from '../../src/program/layout.js';
import { solToLamports } from '../../src/program/math.js';
import { MockRpc } from '../../src/rpc/MockRpc.js';
import { RpcError, type Rpc } from '../../src/rpc/Rpc.js';

let dir: string;
let log: ActivityLog;
let warnings: string[];
const warn = (m: string) => warnings.push(m);
const T0 = new Date('2026-09-14T12:00:00.000Z');

const us = Keypair.generate();
const them = Keypair.generate();
const sol = (s: string) => solToLamports(s);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-reader-'));
  log = new ActivityLog(join(dir, 'activity.jsonl'), { now: () => T0 });
  warnings = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seeded(): MockRpc {
  return new MockRpc({ poster: them.publicKey, amount: sol('0.1'), message: 'hello' });
}

describe('BillboardReader.read', () => {
  it('decodes the account and reports the poster relationship', async () => {
    const rpc = seeded();
    const reader = new BillboardReader(rpc, { wallet: us.publicKey, now: () => T0, warn });
    const r = await reader.read();
    expect(r.state.poster.equals(them.publicKey)).toBe(true);
    expect(r.state.amount).toBe(sol('0.1'));
    expect(r.state.message).toBe('hello');
    expect(r.state.messageBytes).toBe(5);
    expect(r.youArePoster).toBe(false);
    expect(r.fetchedAt).toBe(T0);
    expect(reader.lastSeen).toEqual(r.state);
    expect(reader.current).toEqual(r.state);
  });

  it('changedSinceLastRead is false on the first read and when nothing moved', async () => {
    const reader = new BillboardReader(seeded(), { wallet: us.publicKey, warn });
    expect((await reader.read()).changedSinceLastRead).toBe(false);
    expect((await reader.read()).changedSinceLastRead).toBe(false);
  });

  it('changedSinceLastRead becomes true after an outside acquire, then false again', async () => {
    const rpc = seeded();
    const reader = new BillboardReader(rpc, { wallet: us.publicKey, warn });
    await reader.read();
    await rpc.acquireAs(Keypair.generate(), sol('0.2'), 'new owner');
    const r = await reader.read();
    expect(r.changedSinceLastRead).toBe(true);
    expect(r.state.amount).toBe(sol('0.2'));
    expect(r.state.message).toBe('new owner');
    expect((await reader.read()).changedSinceLastRead).toBe(false);
  });

  it('a message-only change (append) counts as a change', async () => {
    const rpc = seeded();
    const reader = new BillboardReader(rpc, { warn });
    await reader.read();
    await rpc.appendAs(them, ' world');
    expect((await reader.read()).changedSinceLastRead).toBe(true);
  });

  it('youArePoster is true when the wallet holds the slot, false without a wallet', async () => {
    const rpc = new MockRpc({ poster: us.publicKey, amount: sol('0.1') });
    expect((await new BillboardReader(rpc, { wallet: us.publicKey }).read()).youArePoster).toBe(
      true,
    );
    expect((await new BillboardReader(rpc, { wallet: null }).read()).youArePoster).toBe(false);
    expect((await new BillboardReader(rpc).read()).youArePoster).toBe(false);
  });

  it('throws ReaderError when the account does not exist', async () => {
    const reader = new BillboardReader(seeded(), { address: PublicKey.unique(), warn });
    await expect(reader.read()).rejects.toBeInstanceOf(ReaderError);
  });

  it('reads the mainnet PDA by default', () => {
    expect(new BillboardReader(seeded()).address.equals(BILLBOARD_ADDRESS)).toBe(true);
  });
});

describe('outbid detection', () => {
  it('logs outbid_detected via the subscription when the poster moves away from our wallet', async () => {
    const rpc = new MockRpc({ poster: us.publicKey, amount: sol('0.1'), message: 'ours' });
    const reader = new BillboardReader(rpc, { wallet: us.publicKey, activityLog: log, warn });
    expect(reader.subscribe()).toBe(true);
    expect(reader.subscribed).toBe(true);
    await reader.read();
    expect(log.entries()).toHaveLength(0);

    await rpc.acquireAs(them, sol('0.101'), 'mine now');

    const entries = log.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ts: T0.toISOString(),
      event: 'outbid_detected',
      tool: READER_TOOL_NAME,
      billboard_before: { poster: us.publicKey.toBase58(), amount_sol: '0.1' },
      billboard_after: { poster: them.publicKey.toBase58(), amount_sol: '0.101' },
    });
    expect(entries[0]).not.toHaveProperty('reasoning');

    // The subscription does not consume the change from the agent's point of view.
    const r = await reader.read();
    expect(r.changedSinceLastRead).toBe(true);
    expect(r.youArePoster).toBe(false);
    // ...and the read does not log the same flip a second time.
    expect(log.entries()).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('logs outbid_detected on read when there is no subscription', async () => {
    const rpc = new MockRpc({ poster: us.publicKey, amount: sol('0.1') });
    const reader = new BillboardReader(rpc, { wallet: us.publicKey, activityLog: log, warn });
    await reader.read();
    await rpc.acquireAs(them, sol('0.5'));
    expect(log.entries()).toHaveLength(0);
    await reader.read();
    expect(log.entries().map((e) => e.event)).toEqual(['outbid_detected']);
    await reader.read();
    expect(log.entries()).toHaveLength(1);
  });

  it('does not log when someone else is outbid, when we take the slot, or without a wallet', async () => {
    const rpc = seeded();
    const reader = new BillboardReader(rpc, { wallet: us.publicKey, activityLog: log, warn });
    reader.subscribe();
    await reader.read();
    await rpc.acquireAs(Keypair.generate(), sol('0.2')); // them -> stranger
    await rpc.acquireAs(us, sol('0.3')); // stranger -> us
    expect(log.entries()).toHaveLength(0);

    const noWallet = new BillboardReader(rpc, { wallet: null, activityLog: log, warn });
    noWallet.subscribe();
    await noWallet.read();
    await rpc.acquireAs(them, sol('0.4'));
    expect(log.entries().map((e) => e.event)).toEqual(['outbid_detected']); // from `reader` only
  });

  it('observe() lets a write tool record the state after its own transaction', async () => {
    const rpc = seeded();
    const reader = new BillboardReader(rpc, { wallet: us.publicKey, activityLog: log, warn });
    await reader.read(); // them
    await rpc.acquireAs(us, sol('0.2')); // no subscription: reader has not seen this
    reader.observe(rpc.billboard);
    expect(log.entries()).toHaveLength(0);
    await rpc.acquireAs(them, sol('0.3'));
    reader.observe(rpc.billboard);
    expect(log.entries().map((e) => e.event)).toEqual(['outbid_detected']);
    // observe() never affects what the agent last read.
    expect(reader.lastSeen?.poster.equals(them.publicKey)).toBe(true);
    expect(reader.lastSeen?.amount).toBe(sol('0.1'));
  });

  it('a flip to a new poster counts once even with subscription and read both reporting it', async () => {
    const rpc = new MockRpc({ poster: us.publicKey, amount: sol('0.1') });
    const reader = new BillboardReader(rpc, { wallet: us.publicKey, activityLog: log, warn });
    reader.subscribe();
    await reader.read();
    await rpc.acquireAs(them, sol('0.2'));
    await reader.read();
    await rpc.acquireAs(us, sol('0.3'));
    await rpc.acquireAs(them, sol('0.4'));
    await reader.read();
    expect(log.entries().map((e) => e.event)).toEqual(['outbid_detected', 'outbid_detected']);
  });

  it('works without an activity log', async () => {
    const rpc = new MockRpc({ poster: us.publicKey, amount: sol('0.1') });
    const reader = new BillboardReader(rpc, { wallet: us.publicKey, warn });
    reader.subscribe();
    await reader.read();
    await rpc.acquireAs(them, sol('0.2'));
    expect((await reader.read()).youArePoster).toBe(false);
    expect(warnings).toEqual([]);
  });
});

describe('subscription fallback', () => {
  function throwingRpc(base: Rpc): Rpc {
    return {
      ...base,
      getAccount: (pk) => base.getAccount(pk),
      onAccountChange: () => {
        throw new RpcError('onAccountChange failed: websocket unavailable', { kind: 'network' });
      },
    };
  }

  it('returns false and warns when the RPC cannot subscribe; reads still work', async () => {
    const rpc = seeded();
    const reader = new BillboardReader(throwingRpc(rpc), {
      wallet: us.publicKey,
      activityLog: log,
      warn,
    });
    expect(reader.subscribe()).toBe(false);
    expect(reader.subscribed).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('websocket unavailable');
    const r = await reader.read();
    expect(r.state.message).toBe('hello');
  });

  it('subscribe is idempotent and unsubscribe stops events', async () => {
    const rpc = new MockRpc({ poster: us.publicKey, amount: sol('0.1') });
    const reader = new BillboardReader(rpc, { wallet: us.publicKey, activityLog: log, warn });
    expect(reader.subscribe()).toBe(true);
    expect(reader.subscribe()).toBe(true);
    await reader.read();
    reader.unsubscribe();
    reader.unsubscribe(); // second call is harmless
    expect(reader.subscribed).toBe(false);
    await rpc.acquireAs(them, sol('0.2'));
    expect(log.entries()).toHaveLength(0); // no subscription event
    await reader.read();
    expect(log.entries().map((e) => e.event)).toEqual(['outbid_detected']); // caught on read
  });

  it('ignores undecodable subscription payloads with a warning', () => {
    const base = seeded();
    let cb: ((data: Buffer) => void) | null = null;
    const rpc: Rpc = {
      ...base,
      getAccount: (pk) => base.getAccount(pk),
      onAccountChange: (_pk, callback) => {
        cb = callback;
        return () => undefined;
      },
    };
    const reader = new BillboardReader(rpc, { wallet: us.publicKey, activityLog: log, warn });
    reader.subscribe();
    expect(cb).not.toBeNull();
    (cb as unknown as (data: Buffer) => void)(Buffer.from('garbage'));
    const wrongDisc = Buffer.alloc(84);
    BILLBOARD_ACCOUNT_DISCRIMINATOR.copy(wrongDisc);
    wrongDisc[0] ^= 0xff;
    (cb as unknown as (data: Buffer) => void)(wrongDisc);
    expect(warnings).toHaveLength(2);
    expect(reader.current).toBeNull();
    expect(log.entries()).toHaveLength(0);
  });
});
