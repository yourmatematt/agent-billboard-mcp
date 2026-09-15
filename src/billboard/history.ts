/**
 * Flip history: who has held the billboard, for how much, and for how long.
 *
 * Derived from the chain by default. Every transaction that touched the
 * billboard account is listed with `getSignaturesForAddress` (paged, newest
 * first), its log lines are fetched, and each `Acquired` event, recognised
 * by its 8-byte discriminator, becomes one flip. Appends and clears emit
 * `Updated` and are ignored. Block times give the timestamps.
 *
 * When `HISTORY_URL` is set it is tried first, as an accelerator only: a
 * JSON array of `{ wallet, amount, timestamp, tx }` published by the site.
 * The payload is validated with zod and the newest entry is compared with
 * the live account. On any failure (network, HTTP status, shape, or a head
 * that disagrees with the chain) the on-chain path runs instead. The chain
 * is always the source of truth.
 *
 * Hold durations and turnover are the only demand signals the chain offers.
 * Reads are not observable on-chain; nothing here reports or invents a read
 * count.
 */
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

import {
  BILLBOARD_ADDRESS,
  decodeAcquiredEvent,
  type AcquiredEvent,
  type BillboardState,
} from '../program/layout.js';
import type { Rpc, SignatureInfo, SignaturesForAddressOptions } from '../rpc/Rpc.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Flip {
  poster: PublicKey;
  /** Lamports paid by `poster` when it acquired the slot. */
  amount: bigint;
  /** Unix seconds when the acquire landed, or null when no block time is known. */
  timestamp: number | null;
  /** Transaction signature. */
  tx: string;
}

export interface FlipWithHold extends Flip {
  /**
   * Seconds this poster held the slot before the next flip. Null for the
   * newest flip (still holding) and when either timestamp is unknown.
   */
  heldForSeconds: number | null;
}

export interface FlipSummary {
  /** Number of flips in the list. */
  flips: number;
  /** Mean of the known hold durations, whole seconds, or null when there are none. */
  averageHoldSeconds: number | null;
  /** Seconds the current poster has held the slot so far, or null when unknown. */
  currentHoldSeconds: number | null;
}

export type HistorySource = 'history_url' | 'on-chain';

export interface FlipHistory {
  /** Newest first. */
  flips: FlipWithHold[];
  summary: FlipSummary;
  source: HistorySource;
}

type Warn = (message: string) => void;

const silent: Warn = () => undefined;

/** Default number of flips returned. */
export const DEFAULT_HISTORY_LIMIT = 50;
/** Largest `limit` a caller may ask for. */
export const MAX_HISTORY_LIMIT = 500;
/** Hard cap on transactions scanned for one on-chain derivation. */
export const MAX_SCANNED_SIGNATURES = 5_000;
/** Timeout for the optional HISTORY_URL fetch. */
export const HISTORY_FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

const PROGRAM_DATA_PREFIX = 'Program data: ';

/**
 * Extracts every `Acquired` event from a transaction's log lines, in log
 * order. Anchor writes events as `Program data: <base64>`; the payload is
 * the 8-byte event discriminator followed by Borsh fields. Lines for other
 * events (`Updated`) return null from the decoder and are skipped. A line
 * that claims to be `Acquired` but is malformed is skipped with a warning
 * rather than failing the whole history.
 */
export function parseAcquiredEvents(logs: readonly string[], warn: Warn = silent): AcquiredEvent[] {
  const events: AcquiredEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const payload = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length).trim(), 'base64');
    try {
      const event = decodeAcquiredEvent(payload);
      if (event) events.push(event);
    } catch (err) {
      warn(
        `history: skipped a malformed Acquired event (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// On-chain derivation
// ---------------------------------------------------------------------------

export interface OnChainHistoryOptions {
  /** Account to scan. Default: the mainnet billboard PDA. */
  address?: PublicKey;
  /** Stop once this many flips are found. Default DEFAULT_HISTORY_LIMIT. */
  limit?: number;
  /** Signatures per `getSignaturesForAddress` page, 1..1000. Default 1000. */
  pageSize?: number;
  /** Hard cap on transactions scanned. Default MAX_SCANNED_SIGNATURES. */
  maxSignatures?: number;
  /** Log fetches in flight at once. Default 4 (gentle on public RPC). */
  concurrency?: number;
  warn?: Warn;
}

/**
 * Walks the billboard's transaction history newest first and returns up to
 * `limit` flips. Failed transactions are skipped without fetching their
 * logs. A transaction whose logs the node no longer has is skipped with a
 * warning. Timestamps come from the signature listing, then the
 * transaction, then `getBlockTime`, and are null if all three are unknown.
 */
export async function deriveOnChainHistory(
  rpc: Rpc,
  options: OnChainHistoryOptions = {},
): Promise<Flip[]> {
  const address = options.address ?? BILLBOARD_ADDRESS;
  const limit = clampInt(options.limit ?? DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT);
  const pageSize = clampInt(options.pageSize ?? 1000, 1, 1000);
  const maxSignatures = Math.max(1, options.maxSignatures ?? MAX_SCANNED_SIGNATURES);
  const concurrency = clampInt(options.concurrency ?? 4, 1, 32);
  const warn = options.warn ?? silent;

  const flips: Flip[] = [];
  let before: string | undefined;
  let scanned = 0;

  while (flips.length < limit && scanned < maxSignatures) {
    const requested = Math.min(pageSize, maxSignatures - scanned);
    const pageOptions: SignaturesForAddressOptions = { limit: requested };
    if (before !== undefined) pageOptions.before = before;
    const page = await rpc.getSignaturesForAddress(address, pageOptions);
    if (page.length === 0) break;
    scanned += page.length;
    before = page[page.length - 1]!.signature;

    const candidates = page.filter((info) => info.err === null || info.err === undefined);
    for (let i = 0; i < candidates.length && flips.length < limit; i += concurrency) {
      const batch = candidates.slice(i, i + concurrency);
      const fetched = await Promise.all(
        batch.map(async (info) => ({ info, logs: await rpc.getTransactionLogs(info.signature) })),
      );
      for (const { info, logs } of fetched) {
        if (logs === null) {
          warn(`history: no logs available for ${info.signature}; skipped`);
          continue;
        }
        if (logs.err !== null && logs.err !== undefined) continue;
        const events = parseAcquiredEvents(logs.logs, warn);
        if (events.length === 0) continue;
        const timestamp = await resolveBlockTime(rpc, info, logs.blockTime);
        // Newest first overall, so events within one transaction are reversed.
        for (const event of [...events].reverse()) {
          flips.push({ poster: event.poster, amount: event.amount, timestamp, tx: info.signature });
        }
      }
    }

    if (page.length < requested) break;
  }

  return flips.slice(0, limit);
}

async function resolveBlockTime(
  rpc: Rpc,
  info: SignatureInfo,
  fromTransaction: number | null,
): Promise<number | null> {
  if (info.blockTime !== null) return info.blockTime;
  if (fromTransaction !== null) return fromTransaction;
  return rpc.getBlockTime(info.slot);
}

// ---------------------------------------------------------------------------
// Hold durations
// ---------------------------------------------------------------------------

/**
 * Adds `heldForSeconds` to each flip and computes the summary. `flips` must
 * be newest first. `nowSeconds` is the clock used for the current holder.
 * Durations are clamped at zero: a clock or block-time skew never produces a
 * negative hold.
 */
export function withHoldDurations(
  flips: readonly Flip[],
  nowSeconds: number,
): { flips: FlipWithHold[]; summary: FlipSummary } {
  const out: FlipWithHold[] = flips.map((flip, i) => {
    if (i === 0) return { ...flip, heldForSeconds: null };
    const newer = flips[i - 1]!;
    const held =
      newer.timestamp === null || flip.timestamp === null
        ? null
        : Math.max(0, Math.round(newer.timestamp - flip.timestamp));
    return { ...flip, heldForSeconds: held };
  });

  const known = out.map((f) => f.heldForSeconds).filter((h): h is number => h !== null);
  const averageHoldSeconds =
    known.length === 0 ? null : Math.round(known.reduce((a, b) => a + b, 0) / known.length);

  const head = out[0];
  const currentHoldSeconds =
    head === undefined || head.timestamp === null
      ? null
      : Math.max(0, Math.round(nowSeconds - head.timestamp));

  return { flips: out, summary: { flips: out.length, averageHoldSeconds, currentHoldSeconds } };
}

// ---------------------------------------------------------------------------
// HISTORY_URL
// ---------------------------------------------------------------------------

const base58Pubkey = z.string().transform((value, ctx) => {
  try {
    return new PublicKey(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: `wallet is not a valid public key: ${value}` });
    return z.NEVER;
  }
});

/** Lamports, as an integer number or a digit string. Never SOL. */
const lamports = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
  .transform((value, ctx) => {
    try {
      const big = BigInt(value);
      if (big > 0xffff_ffff_ffff_ffffn) throw new Error('above u64');
      return big;
    } catch {
      ctx.addIssue({ code: 'custom', message: `amount is not a lamport count: ${value}` });
      return z.NEVER;
    }
  });

/** Largest plausible unix-seconds value; anything above is treated as milliseconds. */
const MAX_UNIX_SECONDS = 100_000_000_000;

/**
 * Unix seconds (number or digit string; values above 1e11 are taken as
 * milliseconds) or an ISO 8601 string.
 */
const timestampSeconds = z.union([z.number(), z.string()]).transform((value, ctx) => {
  let seconds: number;
  if (typeof value === 'number') {
    seconds = value;
  } else if (/^\d+(\.\d+)?$/.test(value)) {
    seconds = Number(value);
  } else {
    seconds = Date.parse(value) / 1000;
  }
  if (!Number.isFinite(seconds) || seconds < 0) {
    ctx.addIssue({ code: 'custom', message: `timestamp is not a time: ${String(value)}` });
    return z.NEVER;
  }
  return seconds > MAX_UNIX_SECONDS ? seconds / 1000 : seconds;
});

export const historyEntrySchema = z.object({
  wallet: base58Pubkey,
  amount: lamports,
  timestamp: timestampSeconds,
  tx: z.string().min(1),
});

export const historyPayloadSchema = z.array(historyEntrySchema);

export interface FetchHistoryUrlOptions {
  /** Injectable for tests. Default: the global fetch. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  warn?: Warn;
}

/**
 * Fetches and validates a `history.json`. Returns flips newest first, or
 * null on any failure (every failure is reported through `warn`). Never
 * throws: the caller falls back to the chain.
 */
export async function fetchHistoryUrl(
  url: string,
  options: FetchHistoryUrlOptions = {},
): Promise<Flip[] | null> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const warn = options.warn ?? silent;
  const timeoutMs = options.timeoutMs ?? HISTORY_FETCH_TIMEOUT_MS;

  let body: unknown;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      warn(`history: HISTORY_URL returned HTTP ${response.status}; using on-chain history`);
      return null;
    }
    body = await response.json();
  } catch (err) {
    warn(
      `history: HISTORY_URL could not be fetched (${err instanceof Error ? err.message : String(err)}); using on-chain history`,
    );
    return null;
  }

  const parsed = historyPayloadSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
    warn(
      `history: HISTORY_URL payload is not a history.json array${where}: ${first?.message ?? 'invalid'}; using on-chain history`,
    );
    return null;
  }

  return parsed.data
    .map((entry) => ({
      poster: entry.wallet,
      amount: entry.amount,
      timestamp: entry.timestamp,
      tx: entry.tx,
    }))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

/**
 * True when a published history agrees with the live account: its newest
 * entry is the current poster at the current amount (or it is empty and the
 * slot has never been acquired). Anything else means the file is stale or
 * wrong, and the chain must be read instead.
 */
export function historyMatchesChain(flips: readonly Flip[], current: BillboardState): boolean {
  const head = flips[0];
  if (head === undefined) {
    return current.amount === 0n && current.poster.equals(PublicKey.default);
  }
  return head.poster.equals(current.poster) && head.amount === current.amount;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface LoadFlipHistoryOptions {
  /** The live account, used to sanity-check a published history. */
  current: BillboardState;
  /** `HISTORY_URL`, or null to go straight to the chain. */
  historyUrl: string | null;
  limit?: number;
  /** Unix seconds "now", for the current holder's duration. */
  nowSeconds: number;
  fetch?: typeof globalThis.fetch;
  warn?: Warn;
  /** Passed through to the on-chain derivation. */
  onChain?: Omit<OnChainHistoryOptions, 'limit' | 'warn'>;
}

/**
 * Tries `HISTORY_URL` first when configured, falls back to the chain on any
 * failure or disagreement, then attaches hold durations and the summary.
 */
export async function loadFlipHistory(
  rpc: Rpc,
  options: LoadFlipHistoryOptions,
): Promise<FlipHistory> {
  const warn = options.warn ?? silent;
  const limit = clampInt(options.limit ?? DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT);

  let flips: Flip[] | null = null;
  let source: HistorySource = 'on-chain';

  if (options.historyUrl !== null) {
    const fetchOptions: FetchHistoryUrlOptions = { warn };
    if (options.fetch !== undefined) fetchOptions.fetch = options.fetch;
    const published = await fetchHistoryUrl(options.historyUrl, fetchOptions);
    if (published !== null) {
      if (historyMatchesChain(published, options.current)) {
        flips = published.slice(0, limit);
        source = 'history_url';
      } else {
        warn(
          'history: HISTORY_URL newest entry does not match the live billboard; using on-chain history',
        );
      }
    }
  }

  if (flips === null) {
    flips = await deriveOnChainHistory(rpc, { ...(options.onChain ?? {}), limit, warn });
    source = 'on-chain';
  }

  const held = withHoldDurations(flips, options.nowSeconds);
  return { flips: held.flips, summary: held.summary, source };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
