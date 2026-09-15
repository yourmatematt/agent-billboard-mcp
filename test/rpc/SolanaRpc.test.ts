import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { BILLBOARD_ADDRESS, buildClearIx } from '../../src/program/layout.js';
import {
  RpcError,
  describeProgramError,
  extractProgramError,
  withTimeout,
} from '../../src/rpc/Rpc.js';
import {
  DEFAULT_CONFIRM_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  SolanaRpc,
  deriveWsUrl,
  sendError,
  type ConnectionLike,
} from '../../src/rpc/SolanaRpc.js';

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** A connection whose every method hangs unless overridden. */
function fakeConnection(overrides: Partial<ConnectionLike> = {}): ConnectionLike {
  return {
    getAccountInfo: never,
    getLatestBlockhash: never,
    sendRawTransaction: never,
    confirmTransaction: never,
    getSignaturesForAddress: never,
    getTransaction: never,
    onAccountChange: () => 1,
    removeAccountChangeListener: async () => undefined,
    getBlockTime: never,
    ...overrides,
  };
}

const healthyBlockhash = async () => ({
  blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  lastValidBlockHeight: 100,
});

describe('extractProgramError', () => {
  it('reads a Custom code from a confirmed-transaction err object', () => {
    expect(extractProgramError({ err: { InstructionError: [0, { Custom: 6000 }] } })).toBe(6000);
    expect(extractProgramError({ err: { InstructionError: [1, { Custom: 6001 }] } })).toBe(6001);
  });

  it('reads a hex code from a preflight message or from logs', () => {
    expect(
      extractProgramError({
        message:
          'Simulation failed. Message: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1770.',
      }),
    ).toBe(6000);
    expect(
      extractProgramError({
        message: 'failed',
        logs: ['Program log: x', 'Program Fw failed: custom program error: 0x1771'],
      }),
    ).toBe(6001);
  });

  it('returns undefined when there is no custom code', () => {
    expect(extractProgramError({ err: { InstructionError: [0, 'InvalidAccountData'] } })).toBe(
      undefined,
    );
    expect(extractProgramError({ message: 'fetch failed' })).toBeUndefined();
    expect(extractProgramError({})).toBeUndefined();
  });

  it('describes known codes by name', () => {
    expect(describeProgramError(6000)).toBe('6000 (Amount)');
    expect(describeProgramError(6001)).toBe('6001 (Size)');
    expect(describeProgramError(2012)).toBe('2012 (ConstraintAddress)');
    expect(describeProgramError(4242)).toBe('4242');
  });
});

describe('withTimeout', () => {
  it('rejects with a timeout RpcError and keeps extra details', async () => {
    await expect(withTimeout(never(), 5, 'thing', { signature: 'sig' })).rejects.toMatchObject({
      name: 'RpcError',
      kind: 'timeout',
      signature: 'sig',
    });
  });

  it('passes through a settled value', async () => {
    expect(await withTimeout(Promise.resolve(7), 50, 'x')).toBe(7);
  });
});

describe('SolanaRpc', () => {
  it('derives the websocket URL from the RPC URL', () => {
    expect(deriveWsUrl('https://api.mainnet-beta.solana.com')).toBe(
      'wss://api.mainnet-beta.solana.com',
    );
    expect(deriveWsUrl('http://127.0.0.1:8899')).toBe('ws://127.0.0.1:8899');
    const rpc = new SolanaRpc({
      rpcUrl: 'https://example.invalid',
      wsUrl: 'wss://ws.example.invalid',
      connection: fakeConnection(),
    });
    expect(rpc.wsUrl).toBe('wss://ws.example.invalid');
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_CONFIRM_TIMEOUT_MS).toBe(60_000);
  });

  it('times out a hung request with a clear RpcError', async () => {
    const rpc = new SolanaRpc({
      rpcUrl: 'https://example.invalid',
      requestTimeoutMs: 10,
      connection: fakeConnection(),
    });
    await expect(rpc.getAccount(BILLBOARD_ADDRESS)).rejects.toMatchObject({
      name: 'RpcError',
      kind: 'timeout',
      message: 'getAccountInfo timed out after 10 ms',
    });
  });

  it('maps a transport failure to a network RpcError', async () => {
    const rpc = new SolanaRpc({
      rpcUrl: 'https://example.invalid',
      connection: fakeConnection({
        getBlockTime: async () => {
          throw new Error('fetch failed');
        },
      }),
    });
    const error = await rpc.getBlockTime(1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).kind).toBe('network');
    expect((error as RpcError).message).toBe('getBlockTime failed: fetch failed');
  });

  it('returns account data as a Buffer and null for a missing account', async () => {
    const data = Buffer.from([1, 2, 3]);
    const rpc = new SolanaRpc({
      rpcUrl: 'https://example.invalid',
      connection: fakeConnection({
        getAccountInfo: async (key) =>
          key.equals(BILLBOARD_ADDRESS)
            ? { data, executable: false, lamports: 1, owner: PublicKey.default }
            : null,
      }),
    });
    expect(await rpc.getAccount(BILLBOARD_ADDRESS)).toEqual(data);
    expect(await rpc.getAccount(PublicKey.unique())).toBeNull();
  });

  it('sendAndConfirm sets blockhash and fee payer, sends the signed bytes and returns the signature', async () => {
    const signer = Keypair.generate();
    let sentBytes: Uint8Array | undefined;
    const rpc = new SolanaRpc({
      rpcUrl: 'https://example.invalid',
      connection: fakeConnection({
        getLatestBlockhash: healthyBlockhash,
        sendRawTransaction: async (raw) => {
          sentBytes = raw as Uint8Array;
          return 'sig123';
        },
        confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
      }),
    });
    const tx = new Transaction().add(buildClearIx(signer.publicKey));
    expect(await rpc.sendAndConfirm(tx, [signer])).toBe('sig123');
    expect(tx.feePayer?.equals(signer.publicKey)).toBe(true);
    expect(tx.recentBlockhash).toBe('4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi');
    expect(sentBytes).toBeDefined();
    const roundTrip = Transaction.from(sentBytes!);
    expect(roundTrip.verifySignatures()).toBe(true);
  });

  it('sendAndConfirm maps a preflight custom program error to programError with logs', async () => {
    const signer = Keypair.generate();
    const logs = [
      'Program log: AnchorError occurred. Error Code: Amount. Error Number: 6000.',
      'Program Fw failed: custom program error: 0x1770',
    ];
    const rpc = new SolanaRpc({
      rpcUrl: 'https://example.invalid',
      connection: fakeConnection({
        getLatestBlockhash: healthyBlockhash,
        sendRawTransaction: async () => {
          const err = new Error(
            'Simulation failed. Message: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1770.',
          );
          (err as Error & { logs: string[] }).logs = logs;
          throw err;
        },
      }),
    });
    const tx = new Transaction().add(buildClearIx(signer.publicKey));
    const error = await rpc.sendAndConfirm(tx, [signer]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    const rpcError = error as RpcError;
    expect(rpcError.kind).toBe('transaction');
    expect(rpcError.programError).toBe(6000);
    expect(rpcError.logs).toEqual(logs);
    expect(rpcError.signature).toBeUndefined();
    expect(rpcError.message).toContain('6000 (Amount)');
  });

  it('sendAndConfirm reports an on-chain failure after confirmation with the signature', async () => {
    const signer = Keypair.generate();
    const rpc = new SolanaRpc({
      rpcUrl: 'https://example.invalid',
      connection: fakeConnection({
        getLatestBlockhash: healthyBlockhash,
        sendRawTransaction: async () => 'sigFail',
        confirmTransaction: async () => ({
          context: { slot: 1 },
          value: { err: { InstructionError: [0, { Custom: 6001 }] } },
        }),
      }),
    });
    const tx = new Transaction().add(buildClearIx(signer.publicKey));
    await expect(rpc.sendAndConfirm(tx, [signer])).rejects.toMatchObject({
      kind: 'transaction',
      programError: 6001,
      signature: 'sigFail',
    });
  });

  it('a confirmation timeout carries the signature so the operator can check the chain', async () => {
    const signer = Keypair.generate();
    const rpc = new SolanaRpc({
      rpcUrl: 'https://example.invalid',
      confirmTimeoutMs: 10,
      connection: fakeConnection({
        getLatestBlockhash: healthyBlockhash,
        sendRawTransaction: async () => 'sigMaybe',
      }),
    });
    const tx = new Transaction().add(buildClearIx(signer.publicKey));
    await expect(rpc.sendAndConfirm(tx, [signer])).rejects.toMatchObject({
      kind: 'timeout',
      signature: 'sigMaybe',
    });
  });

  it('sendError treats a plain transport error as network, not transaction', () => {
    expect(sendError(new Error('fetch failed')).kind).toBe('network');
    expect(sendError(new Error('Blockhash not found')).kind).toBe('transaction');
  });

  it('normalises signatures and transaction logs', async () => {
    const rpc = new SolanaRpc({
      rpcUrl: 'https://example.invalid',
      connection: fakeConnection({
        getSignaturesForAddress: async () => [
          { signature: 's1', slot: 5, blockTime: 123, err: null, memo: null },
          { signature: 's0', slot: 4, blockTime: undefined, err: { x: 1 }, memo: null },
        ],
        getTransaction: async (sig) =>
          sig === 's1'
            ? { slot: 5, blockTime: 123, meta: { logMessages: ['Program log: hi'], err: null } }
            : null,
      }),
    });
    expect(await rpc.getSignaturesForAddress(BILLBOARD_ADDRESS)).toEqual([
      { signature: 's1', slot: 5, blockTime: 123, err: null },
      { signature: 's0', slot: 4, blockTime: null, err: { x: 1 } },
    ]);
    expect(await rpc.getTransactionLogs('s1')).toEqual({
      signature: 's1',
      slot: 5,
      blockTime: 123,
      logs: ['Program log: hi'],
      err: null,
    });
    expect(await rpc.getTransactionLogs('s0')).toBeNull();
  });

  it('onAccountChange forwards data as a Buffer and unsubscribes by id', async () => {
    let removed: number | undefined;
    let cb: ((info: { data: Buffer }) => void) | undefined;
    const rpc = new SolanaRpc({
      rpcUrl: 'https://example.invalid',
      connection: fakeConnection({
        onAccountChange: (_key, callback) => {
          cb = callback as (info: { data: Buffer }) => void;
          return 42;
        },
        removeAccountChangeListener: async (id) => {
          removed = id;
        },
      }),
    });
    const seen: Buffer[] = [];
    const unsubscribe = rpc.onAccountChange(BILLBOARD_ADDRESS, (data) => seen.push(data));
    cb!({ data: Buffer.from('abc') });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toString()).toBe('abc');
    unsubscribe();
    await Promise.resolve();
    expect(removed).toBe(42);
  });
});
