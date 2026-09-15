/**
 * Wire-format layer for The Agent Billboard program.
 *
 * Everything in this file is derived from `reference/idl.json` and the
 * program source. Nothing here touches the network. Instruction data is
 * hand-encoded (8-byte Anchor discriminator + Borsh args) and the account is
 * hand-decoded from the documented byte layout, so a unit test can prove the
 * exact bytes without an Anchor client.
 *
 * Byte layout of the Billboard account (Borsh, after the 8-byte discriminator):
 *   0..8    discriminator [202,110,74,104,87,241,119,9]
 *   8..40   creator  pubkey
 *   40..72  poster   pubkey
 *   72..80  amount   u64 LE (lamports)
 *   80..84  message length u32 LE
 *   84..    message  UTF-8 bytes
 * On-chain the account is allocated with fixed space, so bytes after the
 * message are zero padding and are ignored by the decoder (Anchor's
 * deserializer tolerates trailing bytes the same way).
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export const PROGRAM_ID = new PublicKey('FwNLuU3KfM3C4JESxa3UZWxBrU5y5ExneEs3kd39wk1n');

/** The single billboard account: PDA of seed "billboard" under PROGRAM_ID. */
export const BILLBOARD_ADDRESS = new PublicKey('CFMq1unofSR9ABZgX3RCwZKX8io2eFUwfaCGns9nFVSQ');

export const BILLBOARD_SEED = Buffer.from('billboard', 'utf8');

// ---------------------------------------------------------------------------
// Program constants (from the IDL `constants` section)
// ---------------------------------------------------------------------------

/** Basis for percentage maths: 10000 = 100%. */
export const HUNDRED = 10_000n;
/** Minimum increase over the current amount, in HUNDREDths: 100 = 1%. */
export const MIN_PERCENT_INCREASE = 100n;
/** Creator's share of the increase, in HUNDREDths: 5000 = 50%. */
export const PERCENT_PROTOCOL = 5_000n;
/** Maximum message size in bytes (not characters). */
export const MESSAGE_SIZE = 4096;

// ---------------------------------------------------------------------------
// Discriminators. Taken verbatim from the IDL, never recomputed at runtime.
// ---------------------------------------------------------------------------

export const BILLBOARD_ACCOUNT_DISCRIMINATOR = Buffer.from([202, 110, 74, 104, 87, 241, 119, 9]);
export const ACQUIRE_DISCRIMINATOR = Buffer.from([100, 174, 191, 60, 2, 131, 195, 28]);
export const APPEND_DISCRIMINATOR = Buffer.from([149, 120, 18, 222, 236, 225, 88, 203]);
export const CLEAR_DISCRIMINATOR = Buffer.from([250, 39, 28, 213, 123, 163, 133, 5]);
export const ACQUIRED_EVENT_DISCRIMINATOR = Buffer.from([118, 103, 215, 213, 152, 230, 185, 6]);
export const UPDATED_EVENT_DISCRIMINATOR = Buffer.from([58, 20, 254, 27, 20, 69, 175, 56]);

/** Program error codes as emitted by the on-chain program. */
export const PROGRAM_ERRORS = {
  /** Bid below the 1% minimum increase. */
  Amount: 6000,
  /** Message would exceed MESSAGE_SIZE bytes. */
  Size: 6001,
  /** Duplicate account provided. */
  Account: 6002,
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LayoutError extends Error {
  override readonly name = 'LayoutError';
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// PDA
// ---------------------------------------------------------------------------

export interface BillboardPda {
  address: PublicKey;
  bump: number;
}

/**
 * Derives the billboard PDA from seeds and asserts it matches the known
 * mainnet address. The server calls this at start-up and refuses to run if
 * the assertion fails, so a wrong program id can never be signed against.
 */
export function deriveBillboardPda(): BillboardPda {
  const [address, bump] = PublicKey.findProgramAddressSync([BILLBOARD_SEED], PROGRAM_ID);
  if (!address.equals(BILLBOARD_ADDRESS)) {
    throw new LayoutError(
      `Billboard PDA mismatch: derived ${address.toBase58()} but expected ${BILLBOARD_ADDRESS.toBase58()}`,
    );
  }
  return { address, bump };
}

// ---------------------------------------------------------------------------
// Account decode / encode
// ---------------------------------------------------------------------------

export interface BillboardState {
  creator: PublicKey;
  poster: PublicKey;
  /** Lamports. Always a bigint, never a JS number. */
  amount: bigint;
  /** Message text, decoded as UTF-8. */
  message: string;
  /** Length of the message in bytes (what the 4096 cap is measured in). */
  messageBytes: number;
}

/** discriminator + creator + poster + amount + message length prefix. */
export const ACCOUNT_HEADER_BYTES = 8 + 32 + 32 + 8 + 4; // 84

/**
 * Decodes a raw billboard account buffer. Validates the discriminator and
 * that the declared message length fits in the buffer. Trailing bytes after
 * the message (fixed-space padding) are ignored.
 */
export function decodeBillboard(buf: Buffer): BillboardState {
  if (buf.length < ACCOUNT_HEADER_BYTES) {
    throw new LayoutError(
      `Billboard account too short: ${buf.length} bytes, need at least ${ACCOUNT_HEADER_BYTES}`,
    );
  }
  const disc = buf.subarray(0, 8);
  if (!disc.equals(BILLBOARD_ACCOUNT_DISCRIMINATOR)) {
    throw new LayoutError(
      `Billboard account discriminator mismatch: got [${Array.from(disc).join(',')}]`,
    );
  }
  const creator = new PublicKey(buf.subarray(8, 40));
  const poster = new PublicKey(buf.subarray(40, 72));
  const amount = buf.readBigUInt64LE(72);
  const messageBytes = buf.readUInt32LE(80);
  if (messageBytes > MESSAGE_SIZE) {
    throw new LayoutError(
      `Billboard message length ${messageBytes} exceeds MESSAGE_SIZE ${MESSAGE_SIZE}`,
    );
  }
  const end = ACCOUNT_HEADER_BYTES + messageBytes;
  if (buf.length < end) {
    throw new LayoutError(
      `Billboard message length ${messageBytes} overruns account data (${buf.length} bytes)`,
    );
  }
  const message = buf.subarray(ACCOUNT_HEADER_BYTES, end).toString('utf8');
  return { creator, poster, amount, message, messageBytes };
}

export interface EncodeBillboardOptions {
  /**
   * Total buffer size to emit. Defaults to the exact size. Pass the on-chain
   * fixed allocation (e.g. 84 + 4096) to mimic a real account with padding.
   */
  totalSize?: number;
}

/**
 * Encodes a billboard state into the account byte layout. Used by the mock
 * RPC and by tests; the server never writes account data itself.
 */
export function encodeBillboard(
  state: Omit<BillboardState, 'messageBytes'>,
  options: EncodeBillboardOptions = {},
): Buffer {
  const messageBuf = Buffer.from(state.message, 'utf8');
  if (messageBuf.length > MESSAGE_SIZE) {
    throw new LayoutError(`Message is ${messageBuf.length} bytes; MESSAGE_SIZE is ${MESSAGE_SIZE}`);
  }
  const exact = ACCOUNT_HEADER_BYTES + messageBuf.length;
  const totalSize = options.totalSize ?? exact;
  if (totalSize < exact) {
    throw new LayoutError(`totalSize ${totalSize} is smaller than encoded size ${exact}`);
  }
  const buf = Buffer.alloc(totalSize);
  BILLBOARD_ACCOUNT_DISCRIMINATOR.copy(buf, 0);
  state.creator.toBuffer().copy(buf, 8);
  state.poster.toBuffer().copy(buf, 40);
  writeU64(buf, 72, state.amount);
  buf.writeUInt32LE(messageBuf.length, 80);
  messageBuf.copy(buf, ACCOUNT_HEADER_BYTES);
  return buf;
}

// ---------------------------------------------------------------------------
// Instruction data encode / decode
// ---------------------------------------------------------------------------

const U64_MAX = (1n << 64n) - 1n;

function writeU64(buf: Buffer, offset: number, value: bigint): void {
  if (typeof value !== 'bigint') {
    throw new LayoutError('u64 values must be bigint');
  }
  if (value < 0n || value > U64_MAX) {
    throw new LayoutError(`u64 out of range: ${value}`);
  }
  buf.writeBigUInt64LE(value, offset);
}

/** Borsh `string`: u32 LE byte length followed by UTF-8 bytes. */
function encodeBorshString(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  const out = Buffer.alloc(4 + bytes.length);
  out.writeUInt32LE(bytes.length, 0);
  bytes.copy(out, 4);
  return out;
}

/** `acquire(amount: u64)` instruction data. */
export function encodeAcquire(amount: bigint): Buffer {
  const out = Buffer.alloc(8 + 8);
  ACQUIRE_DISCRIMINATOR.copy(out, 0);
  writeU64(out, 8, amount);
  return out;
}

/** `append(message: string)` instruction data. */
export function encodeAppend(message: string): Buffer {
  const bytes = Buffer.from(message, 'utf8');
  if (bytes.length > MESSAGE_SIZE) {
    throw new LayoutError(
      `append payload is ${bytes.length} bytes; MESSAGE_SIZE is ${MESSAGE_SIZE}`,
    );
  }
  return Buffer.concat([APPEND_DISCRIMINATOR, encodeBorshString(message)]);
}

/** `clear()` instruction data. */
export function encodeClear(): Buffer {
  return Buffer.from(CLEAR_DISCRIMINATOR);
}

export type DecodedInstruction =
  { kind: 'acquire'; amount: bigint } | { kind: 'append'; message: string } | { kind: 'clear' };

/**
 * Decodes instruction data back into its arguments. Used by the mock RPC to
 * apply program rules and by tests to round-trip the encoders. Unknown
 * discriminators (including `initialise` / `update_creator`) throw.
 */
export function decodeInstructionData(data: Buffer): DecodedInstruction {
  if (data.length < 8) {
    throw new LayoutError(`instruction data too short: ${data.length} bytes`);
  }
  const disc = data.subarray(0, 8);
  if (disc.equals(ACQUIRE_DISCRIMINATOR)) {
    if (data.length !== 16) {
      throw new LayoutError(`acquire data must be 16 bytes, got ${data.length}`);
    }
    return { kind: 'acquire', amount: data.readBigUInt64LE(8) };
  }
  if (disc.equals(APPEND_DISCRIMINATOR)) {
    if (data.length < 12) {
      throw new LayoutError(`append data too short: ${data.length} bytes`);
    }
    const len = data.readUInt32LE(8);
    if (data.length !== 12 + len) {
      throw new LayoutError(`append string length ${len} does not match data (${data.length})`);
    }
    return { kind: 'append', message: data.subarray(12, 12 + len).toString('utf8') };
  }
  if (disc.equals(CLEAR_DISCRIMINATOR)) {
    if (data.length !== 8) {
      throw new LayoutError(`clear data must be 8 bytes, got ${data.length}`);
    }
    return { kind: 'clear' };
  }
  throw new LayoutError(`unknown instruction discriminator [${Array.from(disc).join(',')}]`);
}

// ---------------------------------------------------------------------------
// Events. Anchor emits `Program data: <base64>` log lines; the payload is the
// 8-byte event discriminator followed by Borsh fields.
// ---------------------------------------------------------------------------

export interface AcquiredEvent {
  poster: PublicKey;
  amount: bigint;
}

export function encodeAcquiredEvent(event: AcquiredEvent): Buffer {
  const out = Buffer.alloc(8 + 32 + 8);
  ACQUIRED_EVENT_DISCRIMINATOR.copy(out, 0);
  event.poster.toBuffer().copy(out, 8);
  writeU64(out, 40, event.amount);
  return out;
}

/**
 * Decodes an `Acquired` event payload. Returns null when the payload is not
 * an Acquired event (e.g. `Updated`); throws when it claims to be one but is
 * malformed.
 */
export function decodeAcquiredEvent(payload: Buffer): AcquiredEvent | null {
  if (payload.length < 8) return null;
  if (!payload.subarray(0, 8).equals(ACQUIRED_EVENT_DISCRIMINATOR)) return null;
  if (payload.length !== 48) {
    throw new LayoutError(`Acquired event must be 48 bytes, got ${payload.length}`);
  }
  return {
    poster: new PublicKey(payload.subarray(8, 40)),
    amount: payload.readBigUInt64LE(40),
  };
}

// ---------------------------------------------------------------------------
// Instruction builders (accounts in IDL order)
// ---------------------------------------------------------------------------

export interface AcquireAccounts {
  /** The wallet paying and becoming poster. */
  signer: PublicKey;
  /** Must equal the billboard's current `poster`. */
  prevPoster: PublicKey;
  /** Must equal the billboard's current `creator`. */
  creator: PublicKey;
}

export function buildAcquireIx(accounts: AcquireAccounts, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: BILLBOARD_ADDRESS, isSigner: false, isWritable: true },
      { pubkey: accounts.prevPoster, isSigner: false, isWritable: true },
      { pubkey: accounts.creator, isSigner: false, isWritable: true },
      { pubkey: accounts.signer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeAcquire(amount),
  });
}

export function buildAppendIx(signer: PublicKey, message: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: BILLBOARD_ADDRESS, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeAppend(message),
  });
}

export function buildClearIx(signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: BILLBOARD_ADDRESS, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeClear(),
  });
}
