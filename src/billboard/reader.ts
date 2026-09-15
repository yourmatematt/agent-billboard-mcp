/**
 * Billboard reader: fetch + decode the account over `Rpc`, remember what the
 * agent last saw, and watch for the operator being outbid.
 *
 * Three pieces of state, kept deliberately separate:
 *
 *   - `lastSeen` — the state returned by the previous `read()`. This is what
 *     the agent last looked at, so `changedSinceLastRead` compares against
 *     it and only `read()` updates it. Subscription events never touch it;
 *     if they did, a change could be masked from the agent.
 *   - `lastObserved` — the newest state this process has seen by any route
 *     (a read, a subscription event, or a caller's `observe()` after its own
 *     transaction). Outbid detection compares each new observation against
 *     it, so the same flip is logged once whichever route reported it first.
 *   - the subscription itself, which is optional. `subscribe()` returns
 *     false and logs a warning when the RPC cannot subscribe; reads keep
 *     working and outbid detection then happens on the next `read()`.
 *
 * `read()` always hits the RPC. There is no read cache: the write tools use
 * `read()` to decide whether a proposal is stale, and a cached answer would
 * defeat that check.
 */
import { PublicKey } from '@solana/web3.js';

import type { ActivityLog } from '../log/activity.js';
import { BILLBOARD_ADDRESS, decodeBillboard, type BillboardState } from '../program/layout.js';
import { lamportsToSol } from '../program/math.js';
import type { Rpc, Unsubscribe } from '../rpc/Rpc.js';

export class ReaderError extends Error {
  override readonly name = 'ReaderError';
  constructor(message: string) {
    super(message);
  }
}

export interface BillboardRead {
  state: BillboardState;
  /** True when poster, amount, creator or message differ from the previous `read()`. */
  changedSinceLastRead: boolean;
  /** True when the configured wallet is the current poster. Always false without a wallet. */
  youArePoster: boolean;
  fetchedAt: Date;
}

export interface BillboardReaderOptions {
  /** The operator's public key, or null in read-only mode. */
  wallet?: PublicKey | null;
  /** Where `outbid_detected` entries go. Optional: without it nothing is logged. */
  activityLog?: ActivityLog | null;
  /** Account to read. Default: the mainnet billboard PDA. */
  address?: PublicKey;
  /** Clock for `fetchedAt`. Injectable for tests. */
  now?: () => Date;
  /** Where warnings go. Default: stderr. */
  warn?: (message: string) => void;
}

/** Tool name recorded on `outbid_detected` entries. */
export const READER_TOOL_NAME = 'billboard_reader';

export class BillboardReader {
  readonly address: PublicKey;
  private readonly rpc: Rpc;
  private readonly wallet: PublicKey | null;
  private readonly log: ActivityLog | null;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private lastSeenState: BillboardState | null = null;
  private lastObservedState: BillboardState | null = null;
  private unsubscribeFn: Unsubscribe | null = null;

  constructor(rpc: Rpc, options: BillboardReaderOptions = {}) {
    this.rpc = rpc;
    this.wallet = options.wallet ?? null;
    this.log = options.activityLog ?? null;
    this.address = options.address ?? BILLBOARD_ADDRESS;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /** What the previous `read()` returned, or null before the first read. */
  get lastSeen(): BillboardState | null {
    return this.lastSeenState;
  }

  /** The newest state seen by any route, or null if nothing has been seen. */
  get current(): BillboardState | null {
    return this.lastObservedState;
  }

  get subscribed(): boolean {
    return this.unsubscribeFn !== null;
  }

  /**
   * Fetches and decodes the billboard. Throws `ReaderError` if the account
   * does not exist; decode failures propagate as `LayoutError`.
   */
  async read(): Promise<BillboardRead> {
    const state = await this.peek();
    const fetchedAt = this.now();
    const changedSinceLastRead =
      this.lastSeenState !== null && !statesEqual(this.lastSeenState, state);
    this.lastSeenState = state;
    return {
      state,
      changedSinceLastRead,
      youArePoster: this.isPoster(state),
      fetchedAt,
    };
  }

  /**
   * Fetches and decodes the billboard and records it through `observe()`,
   * but does not update `lastSeen`. The write tools use this after their
   * own transactions land: the process learns the new state (so a later
   * outbid is detected) while `changedSinceLastRead` still tells the agent
   * that the board moved since it last called `read_billboard`.
   */
  async peek(): Promise<BillboardState> {
    const data = await this.rpc.getAccount(this.address);
    if (data === null) {
      throw new ReaderError(`billboard account ${this.address.toBase58()} not found`);
    }
    const state = decodeBillboard(data);
    this.observe(state);
    return state;
  }

  /** True when the configured wallet is `state.poster`. Always false without a wallet. */
  isWalletPoster(state: BillboardState): boolean {
    return this.isPoster(state);
  }

  /**
   * Records a state this process has learned about by some other route —
   * the write tools call this with the state they read after their own
   * transaction lands — so that outbid detection has an accurate "before".
   * Logs `outbid_detected` when the wallet was the poster and no longer is.
   * Does not affect `changedSinceLastRead`.
   */
  observe(state: BillboardState): void {
    const previous = this.lastObservedState;
    this.lastObservedState = state;
    if (previous === null) return;
    if (this.isPoster(previous) && !this.isPoster(state)) {
      this.recordOutbid(previous, state);
    }
  }

  /**
   * Starts watching the account through `rpc.onAccountChange`. Returns true
   * when the subscription is active. When the RPC cannot subscribe the
   * failure is reported through `warn` and false is returned; nothing else
   * changes. Calling it while subscribed is a no-op returning true.
   */
  subscribe(): boolean {
    if (this.unsubscribeFn !== null) return true;
    try {
      this.unsubscribeFn = this.rpc.onAccountChange(this.address, (data) => {
        this.onAccountData(data);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(`billboard subscription unavailable, polling on read only (${message})`);
      this.unsubscribeFn = null;
      return false;
    }
    return true;
  }

  unsubscribe(): void {
    if (this.unsubscribeFn === null) return;
    const fn = this.unsubscribeFn;
    this.unsubscribeFn = null;
    try {
      fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(`billboard unsubscribe failed (${message})`);
    }
  }

  private isPoster(state: BillboardState): boolean {
    return this.wallet !== null && state.poster.equals(this.wallet);
  }

  private onAccountData(data: Buffer): void {
    let state: BillboardState;
    try {
      state = decodeBillboard(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(`ignoring undecodable billboard update (${message})`);
      return;
    }
    this.observe(state);
  }

  private recordOutbid(before: BillboardState, after: BillboardState): void {
    if (this.log === null) return;
    try {
      this.log.append({
        event: 'outbid_detected',
        tool: READER_TOOL_NAME,
        billboard_before: snapshot(before),
        billboard_after: snapshot(after),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(`could not log outbid_detected (${message})`);
    }
  }
}

export function snapshot(state: BillboardState): { poster: string; amount_sol: string } {
  return { poster: state.poster.toBase58(), amount_sol: lamportsToSol(state.amount) };
}

export function statesEqual(a: BillboardState, b: BillboardState): boolean {
  return (
    a.poster.equals(b.poster) &&
    a.creator.equals(b.creator) &&
    a.amount === b.amount &&
    a.messageBytes === b.messageBytes &&
    a.message === b.message
  );
}
