/**
 * `Rpc` over a real `@solana/web3.js` `Connection`.
 *
 * Every request is wrapped in a timeout so a stalled node can never hang a
 * tool call. Errors are normalised to `RpcError` with the program error code
 * extracted when the chain rejected the transaction.
 *
 * Sending is split into send + confirm on purpose: if confirmation times
 * out after the transaction was sent, the error carries the signature so the
 * activity log can record a transaction that may still land.
 */
import {
  Connection,
  type AccountInfo,
  type Commitment,
  type ConfirmedSignatureInfo,
  type PublicKey,
  type RpcResponseAndContext,
  type SignatureResult,
  type Signer,
  type Transaction,
} from '@solana/web3.js';
import {
  describeProgramError,
  extractProgramError,
  RpcError,
  withTimeout,
  type AccountChangeCallback,
  type LatestBlockhash,
  type Rpc,
  type SignatureInfo,
  type SignaturesForAddressOptions,
  type TransactionLogs,
  type Unsubscribe,
} from './Rpc.js';

/**
 * The subset of `Connection` this implementation uses. Structural, so tests
 * can inject a fake without a network.
 */
export interface ConnectionLike {
  getAccountInfo(
    publicKey: PublicKey,
    commitment?: Commitment,
  ): Promise<AccountInfo<Buffer> | null>;
  getLatestBlockhash(commitment?: Commitment): Promise<LatestBlockhash>;
  sendRawTransaction(
    rawTransaction: Buffer | Uint8Array | Array<number>,
    options?: { skipPreflight?: boolean; preflightCommitment?: Commitment },
  ): Promise<string>;
  confirmTransaction(
    strategy: { signature: string; blockhash: string; lastValidBlockHeight: number },
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>>;
  getSignaturesForAddress(
    address: PublicKey,
    options?: SignaturesForAddressOptions,
    commitment?: 'confirmed' | 'finalized',
  ): Promise<ConfirmedSignatureInfo[]>;
  getTransaction(
    signature: string,
    config: { commitment?: 'confirmed' | 'finalized'; maxSupportedTransactionVersion?: number },
  ): Promise<{
    slot: number;
    blockTime?: number | null | undefined;
    meta: { logMessages?: string[] | null | undefined; err: unknown } | null;
  } | null>;
  onAccountChange(
    publicKey: PublicKey,
    callback: (accountInfo: AccountInfo<Buffer>) => void,
    commitment?: Commitment,
  ): number;
  removeAccountChangeListener(id: number): Promise<void>;
  getBlockTime(slot: number): Promise<number | null>;
}

export interface SolanaRpcOptions {
  rpcUrl: string;
  /** Derived from `rpcUrl` (https becomes wss) when omitted. */
  wsUrl?: string | undefined;
  /** Per-request timeout. Default 10 000 ms. */
  requestTimeoutMs?: number;
  /**
   * How long to wait for confirmation after a transaction was sent. Default
   * 60 000 ms: a blockhash stays valid for roughly that long, and giving up
   * earlier would report "failed" for transactions that still land.
   */
  confirmTimeoutMs?: number;
  /** Inject a connection (tests). Default: a new `Connection(rpcUrl)`. */
  connection?: ConnectionLike;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;
const COMMITMENT = 'confirmed' as const;

export function deriveWsUrl(rpcUrl: string): string {
  if (rpcUrl.startsWith('https://')) return 'wss://' + rpcUrl.slice('https://'.length);
  if (rpcUrl.startsWith('http://')) return 'ws://' + rpcUrl.slice('http://'.length);
  return rpcUrl;
}

export class SolanaRpc implements Rpc {
  private readonly conn: ConnectionLike;
  private readonly requestTimeoutMs: number;
  private readonly confirmTimeoutMs: number;
  readonly rpcUrl: string;
  readonly wsUrl: string;

  constructor(options: SolanaRpcOptions) {
    this.rpcUrl = options.rpcUrl;
    this.wsUrl = options.wsUrl ?? deriveWsUrl(options.rpcUrl);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    this.conn =
      options.connection ??
      new Connection(options.rpcUrl, {
        commitment: COMMITMENT,
        wsEndpoint: this.wsUrl,
      });
  }

  private request<T>(label: string, call: () => Promise<T>): Promise<T> {
    let promise: Promise<T>;
    try {
      promise = call();
    } catch (error) {
      return Promise.reject(networkError(label, error));
    }
    return withTimeout(promise, this.requestTimeoutMs, label).catch((error: unknown) => {
      throw error instanceof RpcError ? error : networkError(label, error);
    });
  }

  async getAccount(pubkey: PublicKey): Promise<Buffer | null> {
    const info = await this.request('getAccountInfo', () =>
      this.conn.getAccountInfo(pubkey, COMMITMENT),
    );
    return info ? Buffer.from(info.data) : null;
  }

  async getLatestBlockhash(): Promise<LatestBlockhash> {
    const { blockhash, lastValidBlockHeight } = await this.request('getLatestBlockhash', () =>
      this.conn.getLatestBlockhash(COMMITMENT),
    );
    return { blockhash, lastValidBlockHeight };
  }

  async sendAndConfirm(tx: Transaction, signers: Signer[]): Promise<string> {
    const first = signers[0];
    if (!first) {
      throw new RpcError('sendAndConfirm needs at least one signer', { kind: 'transaction' });
    }
    const { blockhash, lastValidBlockHeight } = await this.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer ??= first.publicKey;
    let raw: Buffer;
    try {
      tx.sign(...signers);
      raw = tx.serialize();
    } catch (error) {
      // Never reaches the network: a missing signer or a transaction over
      // 1232 bytes (web3.js raises a RangeError from the message encoder).
      const detail = error instanceof RangeError ? 'Transaction too large' : errorMessage(error);
      throw new RpcError(`transaction could not be signed: ${detail}`, {
        kind: 'transaction',
        cause: error,
      });
    }

    let signature: string;
    try {
      signature = await withTimeout(
        this.conn.sendRawTransaction(raw, {
          skipPreflight: false,
          preflightCommitment: COMMITMENT,
        }),
        this.requestTimeoutMs,
        'sendTransaction',
      );
    } catch (error) {
      throw error instanceof RpcError ? error : sendError(error);
    }

    let result: RpcResponseAndContext<SignatureResult>;
    try {
      result = await withTimeout(
        this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, COMMITMENT),
        this.confirmTimeoutMs,
        'confirmTransaction',
        { signature },
      );
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(`confirmTransaction failed for ${signature}: ${errorMessage(error)}`, {
        kind: 'network',
        signature,
        cause: error,
      });
    }
    if (result.value.err) {
      const programError = extractProgramError({ err: result.value.err });
      const detail =
        programError === undefined
          ? JSON.stringify(result.value.err)
          : `program error ${describeProgramError(programError)}`;
      throw new RpcError(`transaction ${signature} failed on-chain: ${detail}`, {
        kind: 'transaction',
        signature,
        ...(programError === undefined ? {} : { programError }),
      });
    }
    return signature;
  }

  async getSignaturesForAddress(
    address: PublicKey,
    options: SignaturesForAddressOptions = {},
  ): Promise<SignatureInfo[]> {
    const infos = await this.request('getSignaturesForAddress', () =>
      this.conn.getSignaturesForAddress(address, options, COMMITMENT),
    );
    return infos.map((info) => ({
      signature: info.signature,
      slot: info.slot,
      blockTime: info.blockTime ?? null,
      err: info.err ?? null,
    }));
  }

  async getTransactionLogs(signature: string): Promise<TransactionLogs | null> {
    const tx = await this.request('getTransaction', () =>
      this.conn.getTransaction(signature, {
        commitment: COMMITMENT,
        maxSupportedTransactionVersion: 0,
      }),
    );
    if (!tx) return null;
    return {
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime ?? null,
      logs: tx.meta?.logMessages ?? [],
      err: tx.meta?.err ?? null,
    };
  }

  onAccountChange(pubkey: PublicKey, callback: AccountChangeCallback): Unsubscribe {
    let id: number;
    try {
      id = this.conn.onAccountChange(
        pubkey,
        (info) => {
          callback(Buffer.from(info.data));
        },
        COMMITMENT,
      );
    } catch (error) {
      throw networkError('onAccountChange', error);
    }
    return () => {
      void this.conn.removeAccountChangeListener(id).catch(() => undefined);
    };
  }

  async getBlockTime(slot: number): Promise<number | null> {
    return this.request('getBlockTime', () => this.conn.getBlockTime(slot));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function networkError(label: string, error: unknown): RpcError {
  return new RpcError(`${label} failed: ${errorMessage(error)}`, { kind: 'network', cause: error });
}

/**
 * Maps a `sendRawTransaction` rejection. web3.js throws `SendTransactionError`
 * for preflight failures with the simulation logs attached; a custom program
 * error appears in both the message and the logs.
 */
export function sendError(error: unknown): RpcError {
  const message = errorMessage(error);
  const logs = (error as { logs?: unknown }).logs;
  const logLines = Array.isArray(logs)
    ? logs.filter((l): l is string => typeof l === 'string')
    : undefined;
  const programError = extractProgramError({ message, logs: logLines });
  const looksLikeRejection = /simulation|preflight|instruction|blockhash|signature/i.test(message);
  const kind = programError === undefined && !looksLikeRejection ? 'network' : 'transaction';
  const prefix =
    programError === undefined
      ? 'sendTransaction failed'
      : `transaction rejected with program error ${describeProgramError(programError)}`;
  return new RpcError(`${prefix}: ${message}`, {
    kind,
    cause: error,
    ...(logLines === undefined ? {} : { logs: logLines }),
    ...(programError === undefined ? {} : { programError }),
  });
}
