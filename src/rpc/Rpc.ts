/**
 * The RPC surface the server depends on.
 *
 * Everything above this layer (reader, tools, demo) talks to `Rpc`, never to
 * `@solana/web3.js` `Connection` directly. Production wires `SolanaRpc`;
 * tests and the demo wire `MockRpc`, which applies the program rules in
 * memory. The interface is deliberately small: only what the billboard
 * server actually needs.
 */
import type { PublicKey, Signer, Transaction } from '@solana/web3.js';

export interface LatestBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  /** Unix seconds, or null when the node does not know. */
  blockTime: number | null;
  /** Non-null when the transaction failed on-chain. */
  err: unknown;
}

export interface SignaturesForAddressOptions {
  /** Start searching backwards from this signature (exclusive). */
  before?: string;
  /** Stop when this signature is reached (exclusive). */
  until?: string;
  /** Max results, 1..1000. Default 1000. */
  limit?: number;
}

export interface TransactionLogs {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Raw `Program log:` / `Program data:` lines as the node returned them. */
  logs: string[];
  err: unknown;
}

export type AccountChangeCallback = (data: Buffer) => void;
export type Unsubscribe = () => void;

export interface Rpc {
  /** Raw account data, or null if the account does not exist. */
  getAccount(pubkey: PublicKey): Promise<Buffer | null>;
  getLatestBlockhash(): Promise<LatestBlockhash>;
  /**
   * Signs, sends and waits for `confirmed`. Sets `recentBlockhash` and
   * `feePayer` (first signer) if the caller did not. Resolves with the
   * signature; rejects with `RpcError` (see `programError` for on-chain
   * error codes such as 6000).
   */
  sendAndConfirm(tx: Transaction, signers: Signer[]): Promise<string>;
  /** Newest first. */
  getSignaturesForAddress(
    address: PublicKey,
    options?: SignaturesForAddressOptions,
  ): Promise<SignatureInfo[]>;
  /** Log lines of a confirmed transaction, or null if unknown. */
  getTransactionLogs(signature: string): Promise<TransactionLogs | null>;
  /**
   * Subscribes to account data changes. Returns an unsubscribe function.
   * Implementations may throw if subscriptions are unavailable; callers
   * treat that as "no subscription", not as a fatal error.
   */
  onAccountChange(pubkey: PublicKey, callback: AccountChangeCallback): Unsubscribe;
  /** Unix seconds for a slot, or null if unavailable. */
  getBlockTime(slot: number): Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RpcErrorKind =
  /** The call did not complete within the timeout. */
  | 'timeout'
  /** Transport / node problem: unreachable, HTTP error, malformed response. */
  | 'network'
  /** The transaction was rejected (preflight) or failed on-chain. */
  | 'transaction';

export interface RpcErrorDetails {
  kind: RpcErrorKind;
  /** Set when the failure was a custom program error (e.g. 6000 `Amount`). */
  programError?: number;
  /** Program log lines when the node returned them. */
  logs?: string[];
  /**
   * Set when a transaction was sent before the failure. A `timeout` with a
   * signature means the transaction may still land; the operator must check.
   */
  signature?: string;
  cause?: unknown;
}

export class RpcError extends Error {
  override readonly name = 'RpcError';
  readonly kind: RpcErrorKind;
  readonly programError: number | undefined;
  readonly logs: string[] | undefined;
  readonly signature: string | undefined;

  constructor(message: string, details: RpcErrorDetails) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.kind = details.kind;
    this.programError = details.programError;
    this.logs = details.logs;
    this.signature = details.signature;
  }
}

/** Anchor error names for the codes this program can raise. */
export const PROGRAM_ERROR_NAMES: Readonly<Record<number, string>> = {
  6000: 'Amount',
  6001: 'Size',
  6002: 'Account',
  // Anchor framework constraint errors that the billboard's account
  // constraints (`address = billboard.poster` etc.) surface as.
  2012: 'ConstraintAddress',
};

const CUSTOM_HEX = /custom program error: 0x([0-9a-fA-F]+)/;

/**
 * Extracts a custom program error code from the shapes web3.js produces:
 * the confirmed-transaction `err` object (`{ InstructionError: [i, { Custom: n }] }`),
 * a preflight failure message (`custom program error: 0x1770`), or log lines.
 * Returns undefined when no custom code is present.
 */
export function extractProgramError(input: {
  err?: unknown;
  message?: string;
  logs?: string[] | undefined;
}): number | undefined {
  const fromErr = customFromErrObject(input.err);
  if (fromErr !== undefined) return fromErr;
  const texts: string[] = [];
  if (typeof input.message === 'string') texts.push(input.message);
  if (input.logs) texts.push(...input.logs);
  for (const text of texts) {
    const m = text.match(CUSTOM_HEX);
    if (m?.[1]) return parseInt(m[1], 16);
  }
  return undefined;
}

function customFromErrObject(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const instructionError = (err as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(instructionError) || instructionError.length < 2) return undefined;
  const detail = instructionError[1];
  if (detail && typeof detail === 'object' && 'Custom' in detail) {
    const custom = (detail as { Custom: unknown }).Custom;
    if (typeof custom === 'number') return custom;
  }
  return undefined;
}

/** Human-readable description of a program error code, for messages and logs. */
export function describeProgramError(code: number): string {
  const name = PROGRAM_ERROR_NAMES[code];
  return name ? `${code} (${name})` : `${code}`;
}

/**
 * Rejects with an `RpcError` of kind `timeout` if `promise` does not settle
 * within `ms`. The timer never keeps the process alive.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  extra: Omit<RpcErrorDetails, 'kind'> = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RpcError(`${label} timed out after ${ms} ms`, { kind: 'timeout', ...extra }));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
