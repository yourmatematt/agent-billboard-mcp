/**
 * In-memory `Rpc` that applies The Agent Billboard's program rules.
 *
 * Used by every test and by `npm run demo`. Nothing here touches a network.
 * `sendAndConfirm` behaves like a validator running the real program:
 *
 *   - the transaction is signed and serialised for real, so missing signers
 *     and the 1232-byte size limit fail exactly as they would on-chain;
 *   - each instruction's data is decoded by discriminator and its accounts
 *     are checked against the Anchor constraints in the program's `acquire.rs`;
 *   - `acquire` enforces `amount >= floor(current * 10100 / 10000)` (6000),
 *     splits the payment as the program does, sets the poster, clears the
 *     message and emits an `Acquired` event as a `Program data:` log line;
 *   - `append` / `clear` require `signer == poster` and `append` enforces the
 *     4096-byte cap (6001);
 *   - a transaction is atomic: any failure leaves the state untouched and
 *     nothing is recorded, mirroring a preflight rejection;
 *   - a fake clock (unix seconds) and slot counter advance per transaction so
 *     flip history and hold durations can be tested deterministically.
 *
 * What is not modelled: lamport balances and fees. Payments are recorded in
 * `transfers` so tests can assert who receives what, but no account is ever
 * short of funds.
 *
 * `reference/` holds the IDL, not the Rust source. For `append` and `clear` the
 * non-poster rejection is assumed to be Anchor's `ConstraintAddress` (2012),
 * the same constraint style the program uses for `prev_poster`.
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  type Signer,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  BILLBOARD_ADDRESS,
  MESSAGE_SIZE,
  PROGRAM_ID,
  PROGRAM_ERRORS,
  UPDATED_EVENT_DISCRIMINATOR,
  buildAcquireIx,
  buildAppendIx,
  buildClearIx,
  decodeInstructionData,
  encodeAcquiredEvent,
  encodeBillboard,
  type BillboardState,
} from '../program/layout.js';
import { minimumBid, splitOnAcquire } from '../program/math.js';
import {
  RpcError,
  type AccountChangeCallback,
  type LatestBlockhash,
  type Rpc,
  type SignatureInfo,
  type SignaturesForAddressOptions,
  type TransactionLogs,
  type Unsubscribe,
} from './Rpc.js';

/** Anchor framework error codes the mock raises for constraint failures. */
export const ANCHOR_ERRORS = {
  ConstraintSeeds: 2006,
  ConstraintAddress: 2012,
  InvalidProgramId: 3008,
} as const;

/** The on-chain account is allocated with fixed space: header + MESSAGE_SIZE. */
export const BILLBOARD_ACCOUNT_SIZE = 84 + MESSAGE_SIZE;

export interface MockRpcOptions {
  creator?: PublicKey;
  poster?: PublicKey;
  /** Lamports. Default 0 (nobody has posted). */
  amount?: bigint;
  message?: string;
  /** Fake clock start, unix seconds. Default 1 760 000 000. */
  now?: number;
  /** Starting slot. Default 1 000. */
  slot?: number;
  /** Seconds the clock advances per confirmed transaction. Default 1. */
  secondsPerTx?: number;
}

export interface MockTransfer {
  signature: string;
  from: PublicKey;
  to: PublicKey;
  lamports: bigint;
}

interface MutableState {
  creator: PublicKey;
  poster: PublicKey;
  amount: bigint;
  message: string;
}

export const MOCK_DEFAULT_NOW = 1_760_000_000;
export const MOCK_DEFAULT_SLOT = 1_000;

export class MockRpc implements Rpc {
  private state: MutableState;
  private clock: number;
  private slot: number;
  private readonly secondsPerTx: number;
  private blockhashCounter = 0;
  private readonly slotTimes = new Map<number, number>();
  private readonly txs: TransactionLogs[] = [];
  private readonly listeners = new Set<AccountChangeCallback>();
  private pendingFailure: RpcError | null = null;

  /** Every lamport transfer the program made, in order. */
  readonly transfers: MockTransfer[] = [];

  constructor(options: MockRpcOptions = {}) {
    this.state = {
      creator: options.creator ?? PublicKey.unique(),
      poster: options.poster ?? PublicKey.default,
      amount: options.amount ?? 0n,
      message: options.message ?? '',
    };
    if (Buffer.byteLength(this.state.message, 'utf8') > MESSAGE_SIZE) {
      throw new Error(`MockRpc seed message exceeds ${MESSAGE_SIZE} bytes`);
    }
    this.clock = options.now ?? MOCK_DEFAULT_NOW;
    this.slot = options.slot ?? MOCK_DEFAULT_SLOT;
    this.secondsPerTx = options.secondsPerTx ?? 1;
    this.slotTimes.set(this.slot, this.clock);
  }

  // -------------------------------------------------------------------------
  // Inspection and control (tests / demo)
  // -------------------------------------------------------------------------

  /** A copy of the current billboard state. */
  get billboard(): BillboardState {
    return {
      creator: this.state.creator,
      poster: this.state.poster,
      amount: this.state.amount,
      message: this.state.message,
      messageBytes: Buffer.byteLength(this.state.message, 'utf8'),
    };
  }

  /** Every confirmed transaction, oldest first. */
  get transactions(): readonly TransactionLogs[] {
    return this.txs;
  }

  /** Current fake time, unix seconds. */
  now(): number {
    return this.clock;
  }

  currentSlot(): number {
    return this.slot;
  }

  /** Moves the fake clock forward without a transaction. */
  advanceClock(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`advanceClock needs a non-negative number of seconds, got ${seconds}`);
    }
    this.clock += seconds;
  }

  /**
   * Makes the next `sendAndConfirm` reject with `error` without touching
   * state, so callers can test their handling of a mid-sequence failure.
   */
  failNextSend(error: RpcError): void {
    this.pendingFailure = error;
  }

  /** Convenience: an outside party acquires the slot (optionally with a message). */
  acquireAs(signer: Signer, amount: bigint, message?: string): Promise<string> {
    const tx = new Transaction().add(
      buildAcquireIx(
        { signer: signer.publicKey, prevPoster: this.state.poster, creator: this.state.creator },
        amount,
      ),
    );
    if (message !== undefined && message.length > 0) {
      tx.add(buildAppendIx(signer.publicKey, message));
    }
    return this.sendAndConfirm(tx, [signer]);
  }

  appendAs(signer: Signer, message: string): Promise<string> {
    return this.sendAndConfirm(new Transaction().add(buildAppendIx(signer.publicKey, message)), [
      signer,
    ]);
  }

  clearAs(signer: Signer): Promise<string> {
    return this.sendAndConfirm(new Transaction().add(buildClearIx(signer.publicKey)), [signer]);
  }

  // -------------------------------------------------------------------------
  // Rpc
  // -------------------------------------------------------------------------

  async getAccount(pubkey: PublicKey): Promise<Buffer | null> {
    if (!pubkey.equals(BILLBOARD_ADDRESS)) return null;
    return this.encodeState();
  }

  async getLatestBlockhash(): Promise<LatestBlockhash> {
    this.blockhashCounter += 1;
    const hash = createHash('sha256').update(`mock-blockhash-${this.blockhashCounter}`).digest();
    return { blockhash: bs58.encode(hash), lastValidBlockHeight: this.slot + 150 };
  }

  async sendAndConfirm(tx: Transaction, signers: Signer[]): Promise<string> {
    if (this.pendingFailure) {
      const error = this.pendingFailure;
      this.pendingFailure = null;
      throw error;
    }
    const first = signers[0];
    if (!first) {
      throw new RpcError('sendAndConfirm needs at least one signer', { kind: 'transaction' });
    }
    if (!tx.recentBlockhash) {
      tx.recentBlockhash = (await this.getLatestBlockhash()).blockhash;
    }
    tx.feePayer ??= first.publicKey;

    // Real signing, signature verification and the 1232-byte packet limit.
    // web3.js raises a RangeError from the message encoder when the
    // transaction is too large, before `serialize` gets to say so.
    try {
      tx.sign(...signers);
      tx.serialize();
    } catch (error) {
      throw new RpcError(`transaction rejected: ${describeSigningError(error)}`, {
        kind: 'transaction',
        cause: error,
      });
    }
    const rawSignature = tx.signature;
    if (!rawSignature) {
      throw new RpcError('transaction has no fee payer signature', { kind: 'transaction' });
    }
    const signature = bs58.encode(rawSignature);

    // Apply atomically against a working copy.
    const working: MutableState = { ...this.state };
    const logs: string[] = [];
    const transfers: MockTransfer[] = [];
    for (const [index, ix] of tx.instructions.entries()) {
      try {
        this.applyInstruction(ix, index, working, logs, transfers, signature);
      } catch (error) {
        if (error instanceof ProgramFailure) {
          logs.push(...error.logs);
          throw new RpcError(
            `Simulation failed. Message: Transaction simulation failed: Error processing Instruction ${index}: custom program error: 0x${error.code.toString(16)}. Logs: ${JSON.stringify(logs)}`,
            { kind: 'transaction', programError: error.code, logs },
          );
        }
        throw error;
      }
    }

    // Commit.
    this.state = working;
    this.slot += 1;
    this.clock += this.secondsPerTx;
    this.slotTimes.set(this.slot, this.clock);
    this.transfers.push(...transfers);
    this.txs.push({ signature, slot: this.slot, blockTime: this.clock, logs, err: null });
    this.notify();
    return signature;
  }

  async getSignaturesForAddress(
    address: PublicKey,
    options: SignaturesForAddressOptions = {},
  ): Promise<SignatureInfo[]> {
    if (!address.equals(BILLBOARD_ADDRESS)) return [];
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000);
    const newestFirst = [...this.txs].reverse();
    let start = 0;
    if (options.before !== undefined) {
      const idx = newestFirst.findIndex((t) => t.signature === options.before);
      if (idx === -1) return [];
      start = idx + 1;
    }
    let end = newestFirst.length;
    if (options.until !== undefined) {
      const idx = newestFirst.findIndex((t) => t.signature === options.until);
      if (idx !== -1) end = idx;
    }
    return newestFirst
      .slice(start, end)
      .slice(0, limit)
      .map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: null }));
  }

  async getTransactionLogs(signature: string): Promise<TransactionLogs | null> {
    const tx = this.txs.find((t) => t.signature === signature);
    return tx ? { ...tx, logs: [...tx.logs] } : null;
  }

  onAccountChange(pubkey: PublicKey, callback: AccountChangeCallback): Unsubscribe {
    if (!pubkey.equals(BILLBOARD_ADDRESS)) {
      return () => undefined;
    }
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  async getBlockTime(slot: number): Promise<number | null> {
    return this.slotTimes.get(slot) ?? null;
  }

  // -------------------------------------------------------------------------
  // Program emulation
  // -------------------------------------------------------------------------

  private encodeState(): Buffer {
    return encodeBillboard(this.state, { totalSize: BILLBOARD_ACCOUNT_SIZE });
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const data = this.encodeState();
    for (const listener of this.listeners) {
      try {
        listener(Buffer.from(data));
      } catch {
        // A listener error must never break the chain.
      }
    }
  }

  private applyInstruction(
    ix: TransactionInstruction,
    index: number,
    state: MutableState,
    logs: string[],
    transfers: MockTransfer[],
    signature: string,
  ): void {
    if (!ix.programId.equals(PROGRAM_ID)) {
      throw new RpcError(
        `instruction ${index} targets ${ix.programId.toBase58()}; the mock only runs ${PROGRAM_ID.toBase58()}`,
        { kind: 'transaction' },
      );
    }
    logs.push(`Program ${PROGRAM_ID.toBase58()} invoke [1]`);
    const decoded = decodeInstructionData(ix.data);
    const key = (i: number): PublicKey => {
      const meta = ix.keys[i];
      if (!meta) {
        throw new ProgramFailure(ANCHOR_ERRORS.ConstraintSeeds, 'AccountNotEnoughKeys');
      }
      return meta.pubkey;
    };
    const requireBillboard = (): void => {
      if (!key(0).equals(BILLBOARD_ADDRESS)) {
        throw new ProgramFailure(
          ANCHOR_ERRORS.ConstraintSeeds,
          'ConstraintSeeds',
          'A seeds constraint was violated',
        );
      }
    };
    const requireSystemProgram = (i: number): void => {
      if (!key(i).equals(SystemProgram.programId)) {
        throw new ProgramFailure(
          ANCHOR_ERRORS.InvalidProgramId,
          'InvalidProgramId',
          'Program ID was not as expected',
        );
      }
    };
    const requireAddress = (i: number, expected: PublicKey, name: string): void => {
      if (!key(i).equals(expected)) {
        throw new ProgramFailure(
          ANCHOR_ERRORS.ConstraintAddress,
          'ConstraintAddress',
          `An address constraint was violated (${name})`,
        );
      }
    };

    switch (decoded.kind) {
      case 'acquire': {
        logs.push('Program log: Instruction: Acquire');
        requireBillboard();
        requireAddress(1, state.poster, 'prev_poster');
        requireAddress(2, state.creator, 'creator');
        const signer = key(3);
        requireSystemProgram(4);

        const target = minimumBid(state.amount);
        if (decoded.amount < target) {
          throw new ProgramFailure(
            PROGRAM_ERRORS.Amount,
            'Amount',
            'Amount is too low. Must be at least 1% higher than previous amount.',
          );
        }
        const split = splitOnAcquire(state.amount, decoded.amount);
        const previousAmount = state.amount;
        const prevPoster = state.poster;
        state.poster = signer;
        state.amount = decoded.amount;
        state.message = '';
        logs.push(
          `Program data: ${encodeAcquiredEvent({ poster: signer, amount: decoded.amount }).toString('base64')}`,
        );
        if (previousAmount === 0n) {
          transfers.push({ signature, from: signer, to: state.creator, lamports: decoded.amount });
        } else {
          transfers.push({
            signature,
            from: signer,
            to: state.creator,
            lamports: split.creatorShare,
          });
          transfers.push({
            signature,
            from: signer,
            to: prevPoster,
            lamports: split.prevPosterReceives,
          });
        }
        break;
      }
      case 'append': {
        logs.push('Program log: Instruction: Append');
        requireBillboard();
        requireAddress(1, state.poster, 'signer');
        requireSystemProgram(2);
        const existing = Buffer.byteLength(state.message, 'utf8');
        const incoming = Buffer.byteLength(decoded.message, 'utf8');
        if (existing + incoming > MESSAGE_SIZE) {
          throw new ProgramFailure(
            PROGRAM_ERRORS.Size,
            'Size',
            'Maximum message length is 4096 bytes.',
          );
        }
        state.message += decoded.message;
        logs.push(`Program data: ${UPDATED_EVENT_DISCRIMINATOR.toString('base64')}`);
        break;
      }
      case 'clear': {
        logs.push('Program log: Instruction: Clear');
        requireBillboard();
        requireAddress(1, state.poster, 'signer');
        requireSystemProgram(2);
        state.message = '';
        logs.push(`Program data: ${UPDATED_EVENT_DISCRIMINATOR.toString('base64')}`);
        break;
      }
    }
    logs.push(`Program ${PROGRAM_ID.toBase58()} success`);
  }
}

function describeSigningError(error: unknown): string {
  if (error instanceof RangeError) return 'Transaction too large';
  return error instanceof Error ? error.message : String(error);
}

/** Internal: an Anchor-style failure inside an instruction. */
class ProgramFailure extends Error {
  readonly code: number;
  readonly logs: string[];
  constructor(code: number, name: string, message = name) {
    super(message);
    this.code = code;
    this.logs = [
      `Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${code}. Error Message: ${message}.`,
      `Program ${PROGRAM_ID.toBase58()} failed: custom program error: 0x${code.toString(16)}`,
    ];
  }
}
