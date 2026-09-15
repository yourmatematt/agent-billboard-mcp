import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  deriveOnChainHistory,
  fetchHistoryUrl,
  historyMatchesChain,
  loadFlipHistory,
  parseAcquiredEvents,
  withHoldDurations,
  type Flip,
} from '../../src/billboard/history.js';
import {
  ACQUIRED_EVENT_DISCRIMINATOR,
  BILLBOARD_ADDRESS,
  UPDATED_EVENT_DISCRIMINATOR,
  encodeAcquiredEvent,
  type BillboardState,
} from '../../src/program/layout.js';
import { solToLamports } from '../../src/program/math.js';
import { MockRpc } from '../../src/rpc/MockRpc.js';
import type {
  Rpc,
  SignatureInfo,
  SignaturesForAddressOptions,
  TransactionLogs,
} from '../../src/rpc/Rpc.js';

const sol = (s: string) => solToLamports(s);
const alice = Keypair.generate();
const bob = Keypair.generate();
const carol = Keypair.generate();

function programData(payload: Buffer): string {
  return `Program data: ${payload.toString('base64')}`;
}

function state(poster: PublicKey, amount: bigint): BillboardState {
  return { creator: PublicKey.unique(), poster, amount, message: '', messageBytes: 0 };
}

// ---------------------------------------------------------------------------
// parseAcquiredEvents
// ---------------------------------------------------------------------------

describe('parseAcquiredEvents', () => {
  it('parses a hand-built Program data line and ignores the rest', () => {
    // Bytes assembled by hand from the DOMAIN SPEC: discriminator, pubkey, u64 LE.
    const payload = Buffer.alloc(48);
    Buffer.from([118, 103, 215, 213, 152, 230, 185, 6]).copy(payload, 0);
    alice.publicKey.toBuffer().copy(payload, 8);
    payload.writeBigUInt64LE(101_000_000n, 40);
    expect(payload.subarray(0, 8).equals(ACQUIRED_EVENT_DISCRIMINATOR)).toBe(true);

    const logs = [
      'Program FwNLuU3KfM3C4JESxa3UZWxBrU5y5ExneEs3kd39wk1n invoke [1]',
      'Program log: Instruction: Acquire',
      programData(payload),
      programData(UPDATED_EVENT_DISCRIMINATOR),
      'Program log: not an event',
      'Program FwNLuU3KfM3C4JESxa3UZWxBrU5y5ExneEs3kd39wk1n success',
    ];
    const events = parseAcquiredEvents(logs);
    expect(events).toHaveLength(1);
    expect(events[0]!.poster.equals(alice.publicKey)).toBe(true);
    expect(events[0]!.amount).toBe(101_000_000n);
  });

  it('round-trips encodeAcquiredEvent and keeps log order', () => {
    const logs = [
      programData(encodeAcquiredEvent({ poster: alice.publicKey, amount: 1n })),
      programData(encodeAcquiredEvent({ poster: bob.publicKey, amount: 2n })),
    ];
    const events = parseAcquiredEvents(logs);
    expect(events.map((e) => e.amount)).toEqual([1n, 2n]);
  });

  it('skips a malformed Acquired payload with a warning instead of throwing', () => {
    const warnings: string[] = [];
    const truncated = encodeAcquiredEvent({ poster: alice.publicKey, amount: 5n }).subarray(0, 20);
    const good = encodeAcquiredEvent({ poster: bob.publicKey, amount: 7n });
    const events = parseAcquiredEvents([programData(truncated), programData(good)], (m) =>
      warnings.push(m),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.amount).toBe(7n);
    expect(warnings.join('\n')).toMatch(/malformed Acquired/);
  });

  it('returns nothing for logs without events', () => {
    expect(parseAcquiredEvents([])).toEqual([]);
    expect(parseAcquiredEvents(['Program log: hello', 'Program data: '])).toEqual([]);
    expect(parseAcquiredEvents(['Program data: !!!not base64!!!'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// withHoldDurations
// ---------------------------------------------------------------------------

describe('withHoldDurations', () => {
  const flips: Flip[] = [
    { poster: carol.publicKey, amount: sol('0.2'), timestamp: 2_200, tx: 'sig-c' },
    { poster: bob.publicKey, amount: sol('0.101'), timestamp: 1_600, tx: 'sig-b' },
    { poster: alice.publicKey, amount: sol('0.1'), timestamp: 1_000, tx: 'sig-a' },
  ];

  it('computes hold durations from three flips, newest first', () => {
    const { flips: held, summary } = withHoldDurations(flips, 2_500);
    expect(held.map((f) => f.heldForSeconds)).toEqual([null, 600, 600]);
    expect(summary).toEqual({ flips: 3, averageHoldSeconds: 600, currentHoldSeconds: 300 });
  });

  it('averages uneven holds and rounds to whole seconds', () => {
    const uneven: Flip[] = [
      { ...flips[0]!, timestamp: 2_201 },
      { ...flips[1]!, timestamp: 1_600 },
      { ...flips[2]!, timestamp: 1_000 },
    ];
    const { flips: held, summary } = withHoldDurations(uneven, 2_201);
    expect(held.map((f) => f.heldForSeconds)).toEqual([null, 601, 600]);
    expect(summary.averageHoldSeconds).toBe(601); // 600.5 rounds to 601
    expect(summary.currentHoldSeconds).toBe(0);
  });

  it('returns nulls when a timestamp is unknown', () => {
    const partial: Flip[] = [{ ...flips[0]!, timestamp: null }, flips[1]!, flips[2]!];
    const { flips: held, summary } = withHoldDurations(partial, 9_999);
    expect(held.map((f) => f.heldForSeconds)).toEqual([null, null, 600]);
    expect(summary.currentHoldSeconds).toBeNull();
    expect(summary.averageHoldSeconds).toBe(600);
  });

  it('never produces a negative hold', () => {
    const { flips: held, summary } = withHoldDurations(flips, 100);
    expect(summary.currentHoldSeconds).toBe(0);
    expect(held.every((f) => f.heldForSeconds === null || f.heldForSeconds >= 0)).toBe(true);
  });

  it('handles an empty history', () => {
    expect(withHoldDurations([], 1)).toEqual({
      flips: [],
      summary: { flips: 0, averageHoldSeconds: null, currentHoldSeconds: null },
    });
  });
});

// ---------------------------------------------------------------------------
// deriveOnChainHistory over MockRpc
// ---------------------------------------------------------------------------

describe('deriveOnChainHistory on MockRpc', () => {
  it('finds each acquire, ignores appends and clears, and uses block times', async () => {
    const rpc = new MockRpc({ poster: alice.publicKey, amount: sol('0.1'), message: 'hi' });
    const t0 = rpc.now();
    await rpc.acquireAs(bob, sol('0.101'), 'bob was here');
    await rpc.appendAs(bob, ' and more');
    rpc.advanceClock(600);
    await rpc.acquireAs(carol, sol('0.2'));
    await rpc.clearAs(carol);

    const flips = await deriveOnChainHistory(rpc);
    expect(flips).toHaveLength(2);
    expect(flips[0]!.poster.equals(carol.publicKey)).toBe(true);
    expect(flips[0]!.amount).toBe(sol('0.2'));
    expect(flips[1]!.poster.equals(bob.publicKey)).toBe(true);
    expect(flips[1]!.amount).toBe(sol('0.101'));
    expect(flips[1]!.timestamp).toBe(t0 + 1);
    expect(flips[0]!.timestamp).toBe(t0 + 1 + 1 + 600 + 1);
    expect(flips[0]!.tx).toBe(rpc.transactions[2]!.signature);
    expect(flips[1]!.tx).toBe(rpc.transactions[0]!.signature);
  });

  it('pages through the signature list with a small page size', async () => {
    const rpc = new MockRpc({ poster: alice.publicKey, amount: sol('0.1') });
    let amount = sol('0.1');
    const signers = [bob, carol, alice, bob, carol];
    for (const signer of signers) {
      amount = (amount * 10_100n) / 10_000n;
      await rpc.acquireAs(signer, amount);
      await rpc.appendAs(signer, 'x');
    }
    const flips = await deriveOnChainHistory(rpc, { pageSize: 3 });
    expect(flips).toHaveLength(5);
    expect(flips.map((f) => f.poster.toBase58())).toEqual(
      [...signers].reverse().map((s) => s.publicKey.toBase58()),
    );
  });

  it('stops at `limit` newest flips', async () => {
    const rpc = new MockRpc({ poster: alice.publicKey, amount: sol('0.1') });
    let amount = sol('0.1');
    for (const signer of [bob, carol, bob]) {
      amount = (amount * 10_100n) / 10_000n;
      await rpc.acquireAs(signer, amount);
    }
    const flips = await deriveOnChainHistory(rpc, { limit: 2, pageSize: 1 });
    expect(flips).toHaveLength(2);
    expect(flips[0]!.amount).toBe(amount);
  });

  it('returns nothing for an address with no history', async () => {
    const rpc = new MockRpc({ poster: alice.publicKey, amount: sol('0.1') });
    expect(await deriveOnChainHistory(rpc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deriveOnChainHistory over a hand-rolled Rpc: failed txs, missing logs,
// missing block times, two acquires in one tx
// ---------------------------------------------------------------------------

class StubRpc implements Rpc {
  readonly pageCalls: SignaturesForAddressOptions[] = [];
  readonly logCalls: string[] = [];
  readonly blockTimeCalls: number[] = [];
  constructor(
    private readonly sigs: SignatureInfo[],
    private readonly logs: Map<string, TransactionLogs | null>,
    private readonly blockTimes: Map<number, number> = new Map(),
  ) {}
  async getAccount(): Promise<Buffer | null> {
    return null;
  }
  async getLatestBlockhash(): Promise<never> {
    throw new Error('not used');
  }
  async sendAndConfirm(): Promise<never> {
    throw new Error('not used');
  }
  async getSignaturesForAddress(
    _address: PublicKey,
    options: SignaturesForAddressOptions = {},
  ): Promise<SignatureInfo[]> {
    this.pageCalls.push({ ...options });
    let start = 0;
    if (options.before !== undefined) {
      start = this.sigs.findIndex((s) => s.signature === options.before) + 1;
    }
    return this.sigs.slice(start, start + (options.limit ?? 1000));
  }
  async getTransactionLogs(signature: string): Promise<TransactionLogs | null> {
    this.logCalls.push(signature);
    return this.logs.get(signature) ?? null;
  }
  onAccountChange(): () => void {
    return () => undefined;
  }
  async getBlockTime(slot: number): Promise<number | null> {
    this.blockTimeCalls.push(slot);
    return this.blockTimes.get(slot) ?? null;
  }
}

function sig(signature: string, slot: number, blockTime: number | null, err: unknown = null) {
  return { signature, slot, blockTime, err };
}

function txLogs(signature: string, slot: number, lines: string[], blockTime: number | null = null) {
  return { signature, slot, blockTime, logs: lines, err: null };
}

describe('deriveOnChainHistory edge cases', () => {
  const acquired = (poster: PublicKey, amount: bigint) =>
    programData(encodeAcquiredEvent({ poster, amount }));

  it('skips failed transactions without fetching their logs', async () => {
    const rpc = new StubRpc(
      [
        sig('s3', 30, 300),
        sig('s2', 20, 200, { InstructionError: [0, { Custom: 6000 }] }),
        sig('s1', 10, 100),
      ],
      new Map([
        ['s3', txLogs('s3', 30, [acquired(bob.publicKey, 2n)])],
        ['s2', txLogs('s2', 20, [acquired(carol.publicKey, 1n)])],
        ['s1', txLogs('s1', 10, [acquired(alice.publicKey, 1n)])],
      ]),
    );
    const flips = await deriveOnChainHistory(rpc);
    expect(flips.map((f) => f.tx)).toEqual(['s3', 's1']);
    expect(rpc.logCalls).toEqual(['s3', 's1']);
  });

  it('skips a transaction whose logs are gone, with a warning', async () => {
    const warnings: string[] = [];
    const rpc = new StubRpc(
      [sig('s2', 20, 200), sig('s1', 10, 100)],
      new Map([['s1', txLogs('s1', 10, [acquired(alice.publicKey, 1n)])]]),
    );
    const flips = await deriveOnChainHistory(rpc, { warn: (m) => warnings.push(m) });
    expect(flips.map((f) => f.tx)).toEqual(['s1']);
    expect(warnings.join('\n')).toMatch(/no logs available for s2/);
  });

  it('falls back to the transaction block time, then getBlockTime, then null', async () => {
    const rpc = new StubRpc(
      [sig('s3', 30, null), sig('s2', 20, null), sig('s1', 10, null)],
      new Map([
        ['s3', txLogs('s3', 30, [acquired(carol.publicKey, 3n)], 333)],
        ['s2', txLogs('s2', 20, [acquired(bob.publicKey, 2n)])],
        ['s1', txLogs('s1', 10, [acquired(alice.publicKey, 1n)])],
      ]),
      new Map([[20, 222]]),
    );
    const flips = await deriveOnChainHistory(rpc, { concurrency: 1 });
    expect(flips.map((f) => f.timestamp)).toEqual([333, 222, null]);
    expect(rpc.blockTimeCalls).toEqual([20, 10]);
  });

  it('orders two acquires in one transaction newest first', async () => {
    const rpc = new StubRpc(
      [sig('s1', 10, 100)],
      new Map([
        ['s1', txLogs('s1', 10, [acquired(alice.publicKey, 1n), acquired(bob.publicKey, 2n)])],
      ]),
    );
    const flips = await deriveOnChainHistory(rpc);
    expect(flips.map((f) => f.amount)).toEqual([2n, 1n]);
    expect(flips.every((f) => f.tx === 's1')).toBe(true);
  });

  it('pages with `before` and honours the scan cap', async () => {
    const sigs = Array.from({ length: 10 }, (_, i) => sig(`s${10 - i}`, 10 - i, 1000 - i));
    const logs = new Map(sigs.map((s) => [s.signature, txLogs(s.signature, s.slot, [])]));
    const rpc = new StubRpc(sigs, logs);
    const flips = await deriveOnChainHistory(rpc, { pageSize: 4, maxSignatures: 6 });
    expect(flips).toEqual([]);
    expect(rpc.pageCalls).toEqual([{ limit: 4 }, { limit: 2, before: 's7' }]);
    expect(rpc.logCalls).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// HISTORY_URL
// ---------------------------------------------------------------------------

type FetchImpl = typeof globalThis.fetch;

function fakeFetch(body: unknown, init: { status?: number; raw?: string } = {}): FetchImpl {
  return (async () =>
    new Response(init.raw ?? JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as FetchImpl;
}

describe('fetchHistoryUrl', () => {
  const url = 'https://example.invalid/history.json';

  it('parses a well-formed payload newest first', async () => {
    const fetch = fakeFetch([
      { wallet: alice.publicKey.toBase58(), amount: 100_000_000, timestamp: 1_000, tx: 'a' },
      { wallet: carol.publicKey.toBase58(), amount: '200000000', timestamp: 2_200_000, tx: 'c' },
      {
        wallet: bob.publicKey.toBase58(),
        amount: 101_000_000,
        timestamp: '1970-01-01T00:26:40.000Z',
        tx: 'b',
        extra: 'ignored',
      },
    ]);
    const flips = await fetchHistoryUrl(url, { fetch });
    expect(flips).not.toBeNull();
    expect(flips!.map((f) => f.tx)).toEqual(['c', 'b', 'a']);
    expect(flips![0]!.amount).toBe(200_000_000n);
    expect(flips![1]!.timestamp).toBe(1_600);
    expect(flips![1]!.poster.equals(bob.publicKey)).toBe(true);
  });

  it('treats large numeric timestamps as milliseconds', async () => {
    const fetch = fakeFetch([
      { wallet: alice.publicKey.toBase58(), amount: 1, timestamp: 1_600_000_000_000, tx: 'a' },
    ]);
    const flips = await fetchHistoryUrl(url, { fetch });
    expect(flips![0]!.timestamp).toBe(1_600_000_000);
  });

  it.each([
    ['not an array', { wallet: 'x' }],
    [
      'a SOL decimal amount',
      [{ wallet: alice.publicKey.toBase58(), amount: '0.1', timestamp: 1, tx: 'a' }],
    ],
    [
      'a fractional amount',
      [{ wallet: alice.publicKey.toBase58(), amount: 0.1, timestamp: 1, tx: 'a' }],
    ],
    ['a bad wallet', [{ wallet: 'not-a-key', amount: 1, timestamp: 1, tx: 'a' }]],
    [
      'a bad timestamp',
      [{ wallet: alice.publicKey.toBase58(), amount: 1, timestamp: 'soon', tx: 'a' }],
    ],
    ['a missing tx', [{ wallet: alice.publicKey.toBase58(), amount: 1, timestamp: 1 }]],
  ])('returns null with a warning for %s', async (_label, body) => {
    const warnings: string[] = [];
    const flips = await fetchHistoryUrl(url, {
      fetch: fakeFetch(body),
      warn: (m) => warnings.push(m),
    });
    expect(flips).toBeNull();
    expect(warnings.join('\n')).toMatch(/using on-chain history/);
  });

  it('returns null on invalid JSON, HTTP errors and network failures', async () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(
      await fetchHistoryUrl(url, { fetch: fakeFetch(null, { raw: '{oops' }), warn }),
    ).toBeNull();
    expect(await fetchHistoryUrl(url, { fetch: fakeFetch([], { status: 503 }), warn })).toBeNull();
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as FetchImpl;
    expect(await fetchHistoryUrl(url, { fetch: failing, warn })).toBeNull();
    expect(warnings).toHaveLength(3);
    expect(warnings[1]).toMatch(/HTTP 503/);
    expect(warnings[2]).toMatch(/ECONNREFUSED/);
  });
});

describe('historyMatchesChain', () => {
  it('accepts a head that matches the live poster and amount', () => {
    const flips: Flip[] = [{ poster: bob.publicKey, amount: 5n, timestamp: 1, tx: 'b' }];
    expect(historyMatchesChain(flips, state(bob.publicKey, 5n))).toBe(true);
    expect(historyMatchesChain(flips, state(bob.publicKey, 6n))).toBe(false);
    expect(historyMatchesChain(flips, state(alice.publicKey, 5n))).toBe(false);
  });

  it('accepts an empty history only for a never-acquired slot', () => {
    expect(historyMatchesChain([], state(PublicKey.default, 0n))).toBe(true);
    expect(historyMatchesChain([], state(bob.publicKey, 1n))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadFlipHistory: URL first, chain on any failure
// ---------------------------------------------------------------------------

describe('loadFlipHistory', () => {
  async function seeded() {
    const rpc = new MockRpc({ poster: alice.publicKey, amount: sol('0.1') });
    await rpc.acquireAs(bob, sol('0.101'));
    rpc.advanceClock(100);
    await rpc.acquireAs(carol, sol('0.2'));
    return rpc;
  }

  it('goes straight to the chain without a URL', async () => {
    const rpc = await seeded();
    const history = await loadFlipHistory(rpc, {
      current: rpc.billboard,
      historyUrl: null,
      nowSeconds: rpc.now() + 50,
    });
    expect(history.source).toBe('on-chain');
    expect(history.flips.map((f) => f.heldForSeconds)).toEqual([null, 101]);
    expect(history.summary).toEqual({ flips: 2, averageHoldSeconds: 101, currentHoldSeconds: 50 });
  });

  it('uses the URL when it agrees with the chain', async () => {
    const rpc = await seeded();
    const fetch = fakeFetch([
      { wallet: bob.publicKey.toBase58(), amount: '101000000', timestamp: 10, tx: 'url-b' },
      { wallet: carol.publicKey.toBase58(), amount: '200000000', timestamp: 20, tx: 'url-c' },
    ]);
    const history = await loadFlipHistory(rpc, {
      current: rpc.billboard,
      historyUrl: 'https://example.invalid/history.json',
      nowSeconds: 25,
      fetch,
    });
    expect(history.source).toBe('history_url');
    expect(history.flips.map((f) => f.tx)).toEqual(['url-c', 'url-b']);
    expect(history.summary).toEqual({ flips: 2, averageHoldSeconds: 10, currentHoldSeconds: 5 });
  });

  it('falls back cleanly when the URL payload is malformed', async () => {
    const rpc = await seeded();
    const warnings: string[] = [];
    const history = await loadFlipHistory(rpc, {
      current: rpc.billboard,
      historyUrl: 'https://example.invalid/history.json',
      nowSeconds: rpc.now(),
      fetch: fakeFetch({ flips: 'nope' }),
      warn: (m) => warnings.push(m),
    });
    expect(history.source).toBe('on-chain');
    expect(history.flips).toHaveLength(2);
    expect(history.flips[0]!.poster.equals(carol.publicKey)).toBe(true);
    expect(warnings.join('\n')).toMatch(/not a history\.json array/);
  });

  it('falls back when the URL disagrees with the live account', async () => {
    const rpc = await seeded();
    const warnings: string[] = [];
    const stale = fakeFetch([
      { wallet: bob.publicKey.toBase58(), amount: '101000000', timestamp: 10, tx: 'url-b' },
    ]);
    const history = await loadFlipHistory(rpc, {
      current: rpc.billboard,
      historyUrl: 'https://example.invalid/history.json',
      nowSeconds: rpc.now(),
      fetch: stale,
      warn: (m) => warnings.push(m),
    });
    expect(history.source).toBe('on-chain');
    expect(history.flips).toHaveLength(2);
    expect(warnings.join('\n')).toMatch(/does not match the live billboard/);
  });

  it('respects limit on both paths', async () => {
    const rpc = await seeded();
    const onChain = await loadFlipHistory(rpc, {
      current: rpc.billboard,
      historyUrl: null,
      limit: 1,
      nowSeconds: rpc.now(),
    });
    expect(onChain.flips).toHaveLength(1);
    const fetch = fakeFetch([
      { wallet: bob.publicKey.toBase58(), amount: '101000000', timestamp: 10, tx: 'url-b' },
      { wallet: carol.publicKey.toBase58(), amount: '200000000', timestamp: 20, tx: 'url-c' },
    ]);
    const fromUrl = await loadFlipHistory(rpc, {
      current: rpc.billboard,
      historyUrl: 'https://example.invalid/history.json',
      limit: 1,
      nowSeconds: 25,
      fetch,
    });
    expect(fromUrl.flips.map((f) => f.tx)).toEqual(['url-c']);
  });

  it('exposes sane limit constants', () => {
    expect(DEFAULT_HISTORY_LIMIT).toBeLessThanOrEqual(MAX_HISTORY_LIMIT);
    expect(BILLBOARD_ADDRESS.toBase58()).toBe('CFMq1unofSR9ABZgX3RCwZKX8io2eFUwfaCGns9nFVSQ');
  });
});
