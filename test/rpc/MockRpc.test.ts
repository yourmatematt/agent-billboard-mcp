import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ACQUIRED_EVENT_DISCRIMINATOR,
  BILLBOARD_ADDRESS,
  MESSAGE_SIZE,
  PROGRAM_ERRORS,
  buildAcquireIx,
  buildAppendIx,
  buildClearIx,
  decodeAcquiredEvent,
  decodeBillboard,
} from '../../src/program/layout.js';
import { ANCHOR_ERRORS, BILLBOARD_ACCOUNT_SIZE, MockRpc } from '../../src/rpc/MockRpc.js';
import { RpcError } from '../../src/rpc/Rpc.js';

const SOL = 1_000_000_000n;

function seeded(): { rpc: MockRpc; holder: Keypair; creator: PublicKey } {
  const holder = Keypair.generate();
  const creator = PublicKey.unique();
  const rpc = new MockRpc({
    creator,
    poster: holder.publicKey,
    amount: SOL / 10n, // 0.1 SOL
    message: 'hello from the holder',
  });
  return { rpc, holder, creator };
}

async function expectRpcError(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    return error as RpcError;
  }
  throw new Error('expected the promise to reject');
}

describe('MockRpc account reads', () => {
  it('serves the billboard PDA as a fixed-space account that decodes to the seed state', async () => {
    const { rpc, holder, creator } = seeded();
    const buf = await rpc.getAccount(BILLBOARD_ADDRESS);
    expect(buf).not.toBeNull();
    expect(buf!.length).toBe(BILLBOARD_ACCOUNT_SIZE);
    expect(buf!.length).toBe(84 + MESSAGE_SIZE);
    const state = decodeBillboard(buf!);
    expect(state.creator.equals(creator)).toBe(true);
    expect(state.poster.equals(holder.publicKey)).toBe(true);
    expect(state.amount).toBe(100_000_000n);
    expect(state.message).toBe('hello from the holder');
  });

  it('returns null for any other account', async () => {
    const { rpc } = seeded();
    expect(await rpc.getAccount(PublicKey.unique())).toBeNull();
  });

  it('returns a fresh 32-byte base58 blockhash each call', async () => {
    const { rpc } = seeded();
    const a = await rpc.getLatestBlockhash();
    const b = await rpc.getLatestBlockhash();
    expect(a.blockhash).not.toBe(b.blockhash);
    expect(a.lastValidBlockHeight).toBeGreaterThan(0);
  });
});

describe('MockRpc acquire rules', () => {
  it('rejects a bid below the 1% minimum with program error 6000 and leaves state untouched', async () => {
    const { rpc, holder, creator } = seeded();
    const bidder = Keypair.generate();
    const before = rpc.billboard;
    // Minimum over 0.1 SOL is 0.101 SOL; one lamport short must fail.
    const tx = new Transaction().add(
      buildAcquireIx(
        { signer: bidder.publicKey, prevPoster: holder.publicKey, creator },
        101_000_000n - 1n,
      ),
    );
    const error = await expectRpcError(rpc.sendAndConfirm(tx, [bidder]));
    expect(error.kind).toBe('transaction');
    expect(error.programError).toBe(PROGRAM_ERRORS.Amount);
    expect(error.programError).toBe(6000);
    expect(error.message).toContain('custom program error: 0x1770');
    expect(error.logs?.some((l) => l.includes('Error Code: Amount') && l.includes('6000'))).toBe(
      true,
    );
    expect(rpc.billboard).toEqual(before);
    expect(rpc.transactions).toHaveLength(0);
    expect(rpc.transfers).toHaveLength(0);
  });

  it('accepts exactly the minimum, clears the message, sets the poster and splits the payment', async () => {
    const { rpc, holder, creator } = seeded();
    const bidder = Keypair.generate();
    const tx = new Transaction().add(
      buildAcquireIx(
        { signer: bidder.publicKey, prevPoster: holder.publicKey, creator },
        101_000_000n,
      ),
    );
    const signature = await rpc.sendAndConfirm(tx, [bidder]);
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(80);

    const state = rpc.billboard;
    expect(state.poster.equals(bidder.publicKey)).toBe(true);
    expect(state.amount).toBe(101_000_000n);
    expect(state.message).toBe('');
    expect(state.messageBytes).toBe(0);

    // creator = floor((0.101 - 0.1) * 0.5) = 0.0005 SOL; previous holder gets the rest.
    expect(rpc.transfers).toHaveLength(2);
    const toCreator = rpc.transfers.find((t) => t.to.equals(creator));
    const toHolder = rpc.transfers.find((t) => t.to.equals(holder.publicKey));
    expect(toCreator?.lamports).toBe(500_000n);
    expect(toHolder?.lamports).toBe(100_500_000n);
    expect(toCreator!.lamports + toHolder!.lamports).toBe(101_000_000n);
    expect(toCreator?.from.equals(bidder.publicKey)).toBe(true);
  });

  it('sends the whole amount to the creator on a first post (current amount 0)', async () => {
    const creator = PublicKey.unique();
    const rpc = new MockRpc({ creator });
    const bidder = Keypair.generate();
    await rpc.acquireAs(bidder, 5_000_000n);
    expect(rpc.transfers).toHaveLength(1);
    expect(rpc.transfers[0]?.to.equals(creator)).toBe(true);
    expect(rpc.transfers[0]?.lamports).toBe(5_000_000n);
    expect(rpc.billboard.poster.equals(bidder.publicKey)).toBe(true);
  });

  it('records an Acquired event as a Program data log line', async () => {
    const { rpc } = seeded();
    const bidder = Keypair.generate();
    const signature = await rpc.acquireAs(bidder, 200_000_000n);
    const logs = await rpc.getTransactionLogs(signature);
    expect(logs).not.toBeNull();
    expect(logs!.err).toBeNull();
    const dataLine = logs!.logs.find((l) => l.startsWith('Program data: '));
    expect(dataLine).toBeDefined();
    const payload = Buffer.from(dataLine!.slice('Program data: '.length), 'base64');
    expect(payload.subarray(0, 8).equals(ACQUIRED_EVENT_DISCRIMINATOR)).toBe(true);
    const event = decodeAcquiredEvent(payload);
    expect(event?.poster.equals(bidder.publicKey)).toBe(true);
    expect(event?.amount).toBe(200_000_000n);
    expect(logs!.logs[0]).toMatch(
      /^Program FwNLuU3KfM3C4JESxa3UZWxBrU5y5ExneEs3kd39wk1n invoke \[1\]$/,
    );
    expect(logs!.logs.at(-1)).toMatch(/success$/);
  });

  it('rejects a wrong prev_poster or creator account with an Anchor address constraint error', async () => {
    const { rpc, holder, creator } = seeded();
    const bidder = Keypair.generate();
    const wrongPrev = new Transaction().add(
      buildAcquireIx({ signer: bidder.publicKey, prevPoster: PublicKey.unique(), creator }, SOL),
    );
    const e1 = await expectRpcError(rpc.sendAndConfirm(wrongPrev, [bidder]));
    expect(e1.programError).toBe(ANCHOR_ERRORS.ConstraintAddress);

    const wrongCreator = new Transaction().add(
      buildAcquireIx(
        { signer: bidder.publicKey, prevPoster: holder.publicKey, creator: PublicKey.unique() },
        SOL,
      ),
    );
    const e2 = await expectRpcError(rpc.sendAndConfirm(wrongCreator, [bidder]));
    expect(e2.programError).toBe(ANCHOR_ERRORS.ConstraintAddress);
    expect(rpc.billboard.poster.equals(holder.publicKey)).toBe(true);
  });

  it('rejects a transaction whose required signer did not sign', async () => {
    const { rpc, holder, creator } = seeded();
    const bidder = Keypair.generate();
    const someoneElse = Keypair.generate();
    const tx = new Transaction().add(
      buildAcquireIx({ signer: bidder.publicKey, prevPoster: holder.publicKey, creator }, SOL),
    );
    tx.feePayer = someoneElse.publicKey;
    const error = await expectRpcError(rpc.sendAndConfirm(tx, [someoneElse]));
    expect(error.kind).toBe('transaction');
    expect(error.message).toMatch(/Signature verification failed/i);
    expect(rpc.billboard.poster.equals(holder.publicKey)).toBe(true);
  });
});

describe('MockRpc append and clear rules', () => {
  it('rejects append from a non-poster and leaves the message untouched', async () => {
    const { rpc } = seeded();
    const stranger = Keypair.generate();
    const error = await expectRpcError(rpc.appendAs(stranger, ' intrusion'));
    expect(error.kind).toBe('transaction');
    expect(error.programError).toBe(ANCHOR_ERRORS.ConstraintAddress);
    expect(rpc.billboard.message).toBe('hello from the holder');
    expect(rpc.transactions).toHaveLength(0);
  });

  it('rejects clear from a non-poster', async () => {
    const { rpc } = seeded();
    const stranger = Keypair.generate();
    const error = await expectRpcError(rpc.clearAs(stranger));
    expect(error.programError).toBe(ANCHOR_ERRORS.ConstraintAddress);
    expect(rpc.billboard.message).toBe('hello from the holder');
  });

  it('appends bytes for the poster and emits an Updated event', async () => {
    const { rpc, holder } = seeded();
    const signature = await rpc.appendAs(holder, ' and more');
    expect(rpc.billboard.message).toBe('hello from the holder and more');
    const logs = await rpc.getTransactionLogs(signature);
    expect(logs!.logs).toContain('Program log: Instruction: Append');
    expect(logs!.logs.some((l) => l.startsWith('Program data: '))).toBe(true);
    // Not an Acquired event.
    const dataLine = logs!.logs.find((l) => l.startsWith('Program data: '))!;
    const payload = Buffer.from(dataLine.slice('Program data: '.length), 'base64');
    expect(decodeAcquiredEvent(payload)).toBeNull();
  });

  it('enforces the 4096-byte cap counting existing bytes (error 6001)', async () => {
    const { rpc, holder } = seeded();
    const existing = rpc.billboard.messageBytes;
    let room = MESSAGE_SIZE - existing;
    // Filling exactly to the cap is allowed (in transaction-sized pieces).
    while (room > 0) {
      const piece = Math.min(room, 900);
      await rpc.appendAs(holder, 'x'.repeat(piece));
      room -= piece;
    }
    expect(rpc.billboard.messageBytes).toBe(MESSAGE_SIZE);
    // One more byte is not.
    const error = await expectRpcError(rpc.appendAs(holder, 'y'));
    expect(error.programError).toBe(PROGRAM_ERRORS.Size);
    expect(error.programError).toBe(6001);
    expect(rpc.billboard.messageBytes).toBe(MESSAGE_SIZE);
  });

  it('measures the cap in bytes, not characters', async () => {
    const { rpc, holder } = seeded();
    await rpc.clearAs(holder);
    const twoByte = 'é'; // 2 bytes in UTF-8
    for (let i = 0; i < 2048; i += 256) {
      await rpc.appendAs(holder, twoByte.repeat(256)); // 512 bytes per tx
    }
    expect(rpc.billboard.messageBytes).toBe(4096);
    expect(rpc.billboard.message.length).toBe(2048);
    const error = await expectRpcError(rpc.appendAs(holder, 'a'));
    expect(error.programError).toBe(6001);
  });

  it('clear empties the message for the poster', async () => {
    const { rpc, holder } = seeded();
    await rpc.clearAs(holder);
    expect(rpc.billboard.message).toBe('');
    expect(rpc.billboard.poster.equals(holder.publicKey)).toBe(true);
    expect(rpc.billboard.amount).toBe(100_000_000n);
  });
});

describe('MockRpc acquire + append in one transaction', () => {
  it('applies both instructions atomically and the message survives the clear', async () => {
    const { rpc, holder, creator } = seeded();
    const bidder = Keypair.generate();
    const tx = new Transaction()
      .add(buildAcquireIx({ signer: bidder.publicKey, prevPoster: holder.publicKey, creator }, SOL))
      .add(buildAppendIx(bidder.publicKey, 'new holder, new message'));
    await rpc.sendAndConfirm(tx, [bidder]);
    const state = rpc.billboard;
    expect(state.poster.equals(bidder.publicKey)).toBe(true);
    expect(state.amount).toBe(SOL);
    expect(state.message).toBe('new holder, new message');
    expect(rpc.transactions).toHaveLength(1);
    const logs = rpc.transactions[0]!.logs;
    expect(logs.filter((l) => l === 'Program log: Instruction: Acquire')).toHaveLength(1);
    expect(logs.filter((l) => l === 'Program log: Instruction: Append')).toHaveLength(1);
  });

  it('rolls back the acquire if the append in the same transaction fails', async () => {
    const { rpc, holder, creator } = seeded();
    const bidder = Keypair.generate();
    // Append signed by the bidder but the billboard account is wrong, so
    // instruction 1 fails after instruction 0 succeeded in the working copy.
    const badAppend = buildAppendIx(bidder.publicKey, 'x');
    badAppend.keys[0]!.pubkey = PublicKey.unique();
    const tx = new Transaction()
      .add(buildAcquireIx({ signer: bidder.publicKey, prevPoster: holder.publicKey, creator }, SOL))
      .add(badAppend);
    const error = await expectRpcError(rpc.sendAndConfirm(tx, [bidder]));
    expect(error.message).toContain('Error processing Instruction 1');
    expect(rpc.billboard.poster.equals(holder.publicKey)).toBe(true);
    expect(rpc.billboard.amount).toBe(100_000_000n);
    expect(rpc.billboard.message).toBe('hello from the holder');
    expect(rpc.transfers).toHaveLength(0);
  });
});

describe('MockRpc clock, history and subscriptions', () => {
  it('advances the fake clock and slot per transaction and answers getBlockTime', async () => {
    const rpc = new MockRpc({ now: 1_000_000, slot: 10, secondsPerTx: 5 });
    const a = Keypair.generate();
    expect(rpc.now()).toBe(1_000_000);
    expect(await rpc.getBlockTime(10)).toBe(1_000_000);
    await rpc.acquireAs(a, 1n);
    expect(rpc.now()).toBe(1_000_005);
    expect(rpc.currentSlot()).toBe(11);
    expect(await rpc.getBlockTime(11)).toBe(1_000_005);
    expect(await rpc.getBlockTime(999)).toBeNull();
    rpc.advanceClock(3600);
    expect(rpc.now()).toBe(1_003_605);
  });

  it('lists signatures newest first with before/until/limit paging', async () => {
    const rpc = new MockRpc();
    const a = Keypair.generate();
    const b = Keypair.generate();
    const s1 = await rpc.acquireAs(a, 100n);
    const s2 = await rpc.acquireAs(b, 200n);
    const s3 = await rpc.acquireAs(a, 300n);
    const all = await rpc.getSignaturesForAddress(BILLBOARD_ADDRESS);
    expect(all.map((s) => s.signature)).toEqual([s3, s2, s1]);
    expect(all[0]!.blockTime).toBeGreaterThan(all[2]!.blockTime!);
    expect(await rpc.getSignaturesForAddress(BILLBOARD_ADDRESS, { limit: 2 })).toHaveLength(2);
    const before = await rpc.getSignaturesForAddress(BILLBOARD_ADDRESS, { before: s3 });
    expect(before.map((s) => s.signature)).toEqual([s2, s1]);
    const until = await rpc.getSignaturesForAddress(BILLBOARD_ADDRESS, { until: s1 });
    expect(until.map((s) => s.signature)).toEqual([s3, s2]);
    expect(await rpc.getSignaturesForAddress(PublicKey.unique())).toEqual([]);
    expect(await rpc.getTransactionLogs('nope')).toBeNull();
  });

  it('notifies account subscribers after each commit and stops after unsubscribe', async () => {
    const { rpc, holder } = seeded();
    const seen: string[] = [];
    const unsubscribe = rpc.onAccountChange(BILLBOARD_ADDRESS, (data) => {
      seen.push(decodeBillboard(data).message);
    });
    await rpc.appendAs(holder, '!');
    const stranger = Keypair.generate();
    await expectRpcError(rpc.appendAs(stranger, 'no'));
    expect(seen).toEqual(['hello from the holder!']);
    unsubscribe();
    await rpc.clearAs(holder);
    expect(seen).toEqual(['hello from the holder!']);
  });

  it('failNextSend rejects once without touching state', async () => {
    const { rpc, holder } = seeded();
    rpc.failNextSend(new RpcError('simulated outage', { kind: 'network' }));
    const error = await expectRpcError(rpc.appendAs(holder, ' x'));
    expect(error.kind).toBe('network');
    expect(rpc.billboard.message).toBe('hello from the holder');
    await rpc.appendAs(holder, ' x');
    expect(rpc.billboard.message).toBe('hello from the holder x');
  });

  it('rejects an oversized transaction like a real node would', async () => {
    const { rpc, holder } = seeded();
    await rpc.clearAs(holder);
    const tx = new Transaction().add(buildAppendIx(holder.publicKey, 'a'.repeat(1300)));
    const error = await expectRpcError(rpc.sendAndConfirm(tx, [holder]));
    expect(error.kind).toBe('transaction');
    expect(error.message).toMatch(/too large/i);
    expect(rpc.billboard.message).toBe('');
  });

  it('rejects instructions for any other program', async () => {
    const { rpc, holder } = seeded();
    const ix = buildClearIx(holder.publicKey);
    ix.programId = PublicKey.unique();
    const error = await expectRpcError(rpc.sendAndConfirm(new Transaction().add(ix), [holder]));
    expect(error.kind).toBe('transaction');
    expect(error.message).toMatch(/mock only runs/);
  });
});
