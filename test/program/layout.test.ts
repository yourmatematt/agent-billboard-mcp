import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_HEADER_BYTES,
  ACQUIRE_DISCRIMINATOR,
  ACQUIRED_EVENT_DISCRIMINATOR,
  APPEND_DISCRIMINATOR,
  BILLBOARD_ACCOUNT_DISCRIMINATOR,
  BILLBOARD_ADDRESS,
  BILLBOARD_SEED,
  CLEAR_DISCRIMINATOR,
  HUNDRED,
  LayoutError,
  MESSAGE_SIZE,
  MIN_PERCENT_INCREASE,
  PERCENT_PROTOCOL,
  PROGRAM_ID,
  UPDATED_EVENT_DISCRIMINATOR,
  buildAcquireIx,
  buildAppendIx,
  buildClearIx,
  decodeAcquiredEvent,
  decodeBillboard,
  decodeInstructionData,
  deriveBillboardPda,
  encodeAcquire,
  encodeAcquiredEvent,
  encodeAppend,
  encodeBillboard,
  encodeClear,
} from '../../src/program/layout.js';

interface Idl {
  address: string;
  instructions: { name: string; discriminator: number[] }[];
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string; discriminator: number[] }[];
  constants: { name: string; value: string }[];
}

const idl = JSON.parse(
  readFileSync(new URL('../../reference/idl.json', import.meta.url), 'utf8'),
) as Idl;

function idlDisc(section: 'instructions' | 'accounts' | 'events', name: string): number[] {
  const entry = idl[section].find((e) => e.name === name);
  if (!entry) throw new Error(`no ${section} entry ${name} in idl.json`);
  return entry.discriminator;
}

const creator = Keypair.generate().publicKey;
const poster = Keypair.generate().publicKey;
const signer = Keypair.generate().publicKey;

/** Builds the account bytes by hand from the layout table, independent of encodeBillboard. */
function handBuildAccount(
  msg: string,
  amount: bigint,
  padTo?: number,
): { buf: Buffer; msgBytes: Buffer } {
  const msgBytes = Buffer.from(msg, 'utf8');
  const disc = Buffer.from([202, 110, 74, 104, 87, 241, 119, 9]);
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(msgBytes.length);
  const parts = [disc, creator.toBuffer(), poster.toBuffer(), amountBuf, lenBuf, msgBytes];
  let buf = Buffer.concat(parts);
  if (padTo !== undefined) {
    buf = Buffer.concat([buf, Buffer.alloc(padTo - buf.length)]);
  }
  return { buf, msgBytes };
}

describe('constants match reference/idl.json', () => {
  it('program id and PDA', () => {
    expect(PROGRAM_ID.toBase58()).toBe(idl.address);
    expect(PROGRAM_ID.toBase58()).toBe('FwNLuU3KfM3C4JESxa3UZWxBrU5y5ExneEs3kd39wk1n');
    expect(BILLBOARD_ADDRESS.toBase58()).toBe('CFMq1unofSR9ABZgX3RCwZKX8io2eFUwfaCGns9nFVSQ');
    expect(BILLBOARD_SEED.toString('utf8')).toBe('billboard');
  });

  it('discriminators', () => {
    expect(Array.from(BILLBOARD_ACCOUNT_DISCRIMINATOR)).toEqual(idlDisc('accounts', 'Billboard'));
    expect(Array.from(ACQUIRE_DISCRIMINATOR)).toEqual(idlDisc('instructions', 'acquire'));
    expect(Array.from(APPEND_DISCRIMINATOR)).toEqual(idlDisc('instructions', 'append'));
    expect(Array.from(CLEAR_DISCRIMINATOR)).toEqual(idlDisc('instructions', 'clear'));
    expect(Array.from(ACQUIRED_EVENT_DISCRIMINATOR)).toEqual(idlDisc('events', 'Acquired'));
    expect(Array.from(UPDATED_EVENT_DISCRIMINATOR)).toEqual(idlDisc('events', 'Updated'));
  });

  it('numeric constants', () => {
    const c = (name: string): string => {
      const entry = idl.constants.find((e) => e.name === name);
      if (!entry) throw new Error(`no constant ${name}`);
      return entry.value;
    };
    expect(HUNDRED).toBe(BigInt(c('HUNDRED')));
    expect(MIN_PERCENT_INCREASE).toBe(BigInt(c('MIN_PERCENT_INCREASE')));
    expect(PERCENT_PROTOCOL).toBe(BigInt(c('PERCENT_PROTOCOL')));
    expect(MESSAGE_SIZE).toBe(Number(c('MESSAGE_SIZE')));
    expect(ACCOUNT_HEADER_BYTES).toBe(84);
  });
});

describe('deriveBillboardPda', () => {
  it('derives the known mainnet address from the seed', () => {
    const { address, bump } = deriveBillboardPda();
    expect(address.equals(BILLBOARD_ADDRESS)).toBe(true);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
    // Independent derivation, no constants from the module under test.
    const [independent] = PublicKey.findProgramAddressSync(
      [Buffer.from('billboard')],
      new PublicKey('FwNLuU3KfM3C4JESxa3UZWxBrU5y5ExneEs3kd39wk1n'),
    );
    expect(independent.toBase58()).toBe('CFMq1unofSR9ABZgX3RCwZKX8io2eFUwfaCGns9nFVSQ');
  });
});

describe('decodeBillboard', () => {
  it('decodes a hand-built buffer matching the layout table', () => {
    const { buf, msgBytes } = handBuildAccount('hello billboard', 100_000_000n);
    const state = decodeBillboard(buf);
    expect(state.creator.equals(creator)).toBe(true);
    expect(state.poster.equals(poster)).toBe(true);
    expect(state.amount).toBe(100_000_000n);
    expect(typeof state.amount).toBe('bigint');
    expect(state.message).toBe('hello billboard');
    expect(state.messageBytes).toBe(msgBytes.length);
  });

  it('ignores zero padding after the message (fixed-space account)', () => {
    const { buf } = handBuildAccount('padded', 5n, ACCOUNT_HEADER_BYTES + MESSAGE_SIZE);
    expect(buf.length).toBe(84 + 4096);
    const state = decodeBillboard(buf);
    expect(state.message).toBe('padded');
    expect(state.messageBytes).toBe(6);
  });

  it('decodes an empty message and zero amount (fresh board)', () => {
    const { buf } = handBuildAccount('', 0n);
    const state = decodeBillboard(buf);
    expect(state.message).toBe('');
    expect(state.messageBytes).toBe(0);
    expect(state.amount).toBe(0n);
  });

  it('round-trips multi-byte UTF-8 and reports byte length, not char length', () => {
    const msg = 'gday 🦘 café — 日本語';
    const { buf, msgBytes } = handBuildAccount(msg, 1n);
    const state = decodeBillboard(buf);
    expect(state.message).toBe(msg);
    expect(state.messageBytes).toBe(msgBytes.length);
    expect(state.messageBytes).toBeGreaterThan(msg.length);
  });

  it('rejects a wrong discriminator', () => {
    const { buf } = handBuildAccount('x', 1n);
    buf[0] = 0;
    expect(() => decodeBillboard(buf)).toThrow(LayoutError);
    expect(() => decodeBillboard(buf)).toThrow(/discriminator/);
  });

  it('rejects a buffer shorter than the header', () => {
    expect(() => decodeBillboard(Buffer.alloc(83))).toThrow(/too short/);
  });

  it('rejects a message length that overruns the buffer', () => {
    const { buf } = handBuildAccount('abc', 1n);
    buf.writeUInt32LE(4, 80);
    expect(() => decodeBillboard(buf)).toThrow(/overruns/);
  });

  it('rejects a message length above MESSAGE_SIZE', () => {
    const { buf } = handBuildAccount('abc', 1n);
    buf.writeUInt32LE(4097, 80);
    expect(() => decodeBillboard(buf)).toThrow(/exceeds MESSAGE_SIZE/);
  });
});

describe('encodeBillboard', () => {
  it('produces bytes identical to the hand-built layout', () => {
    const { buf } = handBuildAccount('same bytes', 123n);
    const encoded = encodeBillboard({ creator, poster, amount: 123n, message: 'same bytes' });
    expect(encoded.equals(buf)).toBe(true);
  });

  it('pads to totalSize and still decodes', () => {
    const encoded = encodeBillboard(
      { creator, poster, amount: 1n, message: 'pad' },
      { totalSize: 84 + 4096 },
    );
    expect(encoded.length).toBe(84 + 4096);
    expect(decodeBillboard(encoded).message).toBe('pad');
  });

  it('rejects messages over MESSAGE_SIZE bytes', () => {
    expect(() =>
      encodeBillboard({ creator, poster, amount: 1n, message: 'a'.repeat(4097) }),
    ).toThrow(LayoutError);
  });
});

describe('instruction data encoding', () => {
  it('encodeAcquire = discriminator + u64 LE', () => {
    const data = encodeAcquire(101_000_000n);
    expect(data.length).toBe(16);
    expect(Array.from(data.subarray(0, 8))).toEqual(idlDisc('instructions', 'acquire'));
    expect(data.readBigUInt64LE(8)).toBe(101_000_000n);
    // Little-endian spot check: 0x0102 -> [0x02, 0x01, 0, ...]
    const le = encodeAcquire(0x0102n);
    expect(Array.from(le.subarray(8))).toEqual([2, 1, 0, 0, 0, 0, 0, 0]);
  });

  it('encodeAcquire rejects out-of-range and non-bigint values', () => {
    expect(() => encodeAcquire(-1n)).toThrow(LayoutError);
    expect(() => encodeAcquire(1n << 64n)).toThrow(LayoutError);
    expect(encodeAcquire((1n << 64n) - 1n).readBigUInt64LE(8)).toBe((1n << 64n) - 1n);
    expect(() => encodeAcquire(5 as unknown as bigint)).toThrow(/bigint/);
  });

  it('encodeAppend = discriminator + u32 LE length + UTF-8 bytes', () => {
    const msg = 'hi 🦘';
    const bytes = Buffer.from(msg, 'utf8');
    const data = encodeAppend(msg);
    expect(Array.from(data.subarray(0, 8))).toEqual(idlDisc('instructions', 'append'));
    expect(data.readUInt32LE(8)).toBe(bytes.length);
    expect(data.subarray(12).equals(bytes)).toBe(true);
    expect(data.length).toBe(12 + bytes.length);
  });

  it('encodeAppend rejects payloads over MESSAGE_SIZE', () => {
    expect(() => encodeAppend('a'.repeat(4097))).toThrow(LayoutError);
    expect(encodeAppend('a'.repeat(4096)).length).toBe(12 + 4096);
  });

  it('encodeClear = discriminator only', () => {
    const data = encodeClear();
    expect(Array.from(data)).toEqual(idlDisc('instructions', 'clear'));
    expect(data.length).toBe(8);
  });

  it('decodeInstructionData round-trips all three, including multi-byte UTF-8', () => {
    expect(decodeInstructionData(encodeAcquire(42n))).toEqual({ kind: 'acquire', amount: 42n });
    const msg = 'round 🦘 trip — 日本語';
    expect(decodeInstructionData(encodeAppend(msg))).toEqual({ kind: 'append', message: msg });
    expect(decodeInstructionData(encodeClear())).toEqual({ kind: 'clear' });
  });

  it('decodeInstructionData rejects unknown discriminators and malformed lengths', () => {
    // `initialise` discriminator from the IDL: never exposed by the server.
    const init = Buffer.from(idlDisc('instructions', 'initialise'));
    expect(() => decodeInstructionData(init)).toThrow(/unknown instruction/);
    expect(() => decodeInstructionData(Buffer.alloc(3))).toThrow(/too short/);
    expect(() => decodeInstructionData(encodeAcquire(1n).subarray(0, 12))).toThrow(/16 bytes/);
    const badAppend = encodeAppend('abc');
    badAppend.writeUInt32LE(9, 8);
    expect(() => decodeInstructionData(badAppend)).toThrow(/does not match/);
    expect(() => decodeInstructionData(Buffer.concat([encodeClear(), Buffer.alloc(1)]))).toThrow(
      /8 bytes/,
    );
  });
});

describe('Acquired event', () => {
  it('encodes discriminator + pubkey + u64 LE and decodes back', () => {
    const payload = encodeAcquiredEvent({ poster, amount: 7n });
    expect(payload.length).toBe(48);
    expect(Array.from(payload.subarray(0, 8))).toEqual(idlDisc('events', 'Acquired'));
    expect(payload.subarray(8, 40).equals(poster.toBuffer())).toBe(true);
    expect(payload.readBigUInt64LE(40)).toBe(7n);
    const decoded = decodeAcquiredEvent(payload);
    expect(decoded?.poster.equals(poster)).toBe(true);
    expect(decoded?.amount).toBe(7n);
  });

  it('returns null for other events and throws on a truncated Acquired', () => {
    expect(decodeAcquiredEvent(Buffer.from(UPDATED_EVENT_DISCRIMINATOR))).toBeNull();
    expect(decodeAcquiredEvent(Buffer.alloc(3))).toBeNull();
    const truncated = encodeAcquiredEvent({ poster, amount: 1n }).subarray(0, 40);
    expect(() => decodeAcquiredEvent(truncated)).toThrow(LayoutError);
  });
});

describe('instruction builders (accounts in IDL order)', () => {
  it('buildAcquireIx: billboard, prev_poster, creator, signer, system_program', () => {
    const ix = buildAcquireIx({ signer, prevPoster: poster, creator }, 101n);
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      BILLBOARD_ADDRESS.toBase58(),
      poster.toBase58(),
      creator.toBase58(),
      signer.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [false, true],
      [false, true],
      [false, true],
      [true, true],
      [false, false],
    ]);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(idlDisc('instructions', 'acquire'));
    expect(decodeInstructionData(Buffer.from(ix.data))).toEqual({ kind: 'acquire', amount: 101n });
  });

  it('buildAppendIx: billboard, signer, system_program', () => {
    const ix = buildAppendIx(signer, 'msg');
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      BILLBOARD_ADDRESS.toBase58(),
      signer.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [false, true],
      [true, true],
      [false, false],
    ]);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(idlDisc('instructions', 'append'));
    expect(decodeInstructionData(Buffer.from(ix.data))).toEqual({ kind: 'append', message: 'msg' });
  });

  it('buildClearIx: billboard, signer, system_program', () => {
    const ix = buildClearIx(signer);
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      BILLBOARD_ADDRESS.toBase58(),
      signer.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [false, true],
      [true, true],
      [false, false],
    ]);
    expect(Array.from(ix.data)).toEqual(idlDisc('instructions', 'clear'));
  });
});
