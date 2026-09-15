/**
 * Pure bid maths for The Agent Billboard.
 *
 * Every function here mirrors the integer arithmetic the on-chain program
 * performs, in lamports, as `bigint`. Nothing uses a JS `number` for money.
 * SOL is only ever a decimal string at the tool boundary, converted here with
 * exact string arithmetic (no floats, no rounding).
 *
 * Program rules (constants from `layout.ts`, verified against the IDL):
 *   minimum bid      target = floor(current * (HUNDRED + MIN_PERCENT_INCREASE) / HUNDRED)
 *   creator share    floor((bid - current) * PERCENT_PROTOCOL / HUNDRED)   when current > 0
 *                    bid                                                     when current == 0
 *   previous poster  bid - creator share
 */
import { HUNDRED, MIN_PERCENT_INCREASE, PERCENT_PROTOCOL } from './layout.js';

export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
const U64_MAX = 18_446_744_073_709_551_615n;

export class MathError extends Error {
  override readonly name = 'MathError';
  constructor(message: string) {
    super(message);
  }
}

function assertLamports(value: bigint, label: string): void {
  if (typeof value !== 'bigint') {
    throw new MathError(`${label} must be a bigint (lamports), got ${typeof value}`);
  }
  if (value < 0n) {
    throw new MathError(`${label} must not be negative, got ${value}`);
  }
  if (value > U64_MAX) {
    throw new MathError(`${label} exceeds u64: ${value}`);
  }
}

// ---------------------------------------------------------------------------
// Bid rules
// ---------------------------------------------------------------------------

/**
 * Smallest bid the program will accept over `current` lamports:
 * `floor(current * 10100 / 10000)`. Rounds down, exactly as the program does.
 * When `current` is 0 (no one has ever posted) the program's minimum is 0.
 */
export function minimumBid(current: bigint): bigint {
  assertLamports(current, 'current amount');
  return (current * (HUNDRED + MIN_PERCENT_INCREASE)) / HUNDRED;
}

export interface AcquireSplit {
  /** Lamports the creator receives. */
  creatorShare: bigint;
  /** Lamports the displaced poster receives (their stake back plus half the increase). */
  prevPosterReceives: bigint;
}

/**
 * Where a bid of `bid` lamports goes when acquiring over `current` lamports.
 * First post (`current == 0`): everything goes to the creator. Otherwise the
 * creator takes `floor((bid - current) * 5000 / 10000)` and the previous
 * poster gets the rest, so `creatorShare + prevPosterReceives == bid` always.
 *
 * Throws if `bid` is below `minimumBid(current)`; the program would reject
 * that transaction with error 6000 (`Amount`), so there is no valid split.
 */
export function splitOnAcquire(current: bigint, bid: bigint): AcquireSplit {
  assertLamports(current, 'current amount');
  assertLamports(bid, 'bid');
  const minimum = minimumBid(current);
  if (bid < minimum) {
    throw new MathError(`bid ${bid} is below the minimum ${minimum} over current ${current}`);
  }
  if (current === 0n) {
    return { creatorShare: bid, prevPosterReceives: 0n };
  }
  const creatorShare = ((bid - current) * PERCENT_PROTOCOL) / HUNDRED;
  return { creatorShare, prevPosterReceives: bid - creatorShare };
}

export interface OutbidAtMinimum {
  /** The least someone must pay to displace a holder at `bid`. */
  nextMinimumBid: bigint;
  /** What the creator takes from that displacement. */
  creatorShare: bigint;
  /** What the displaced holder gets back. */
  youReceive: bigint;
}

/**
 * If you hold the slot at `bid` and are outbid at the minimum:
 * `m = floor(bid * 10100 / 10000)`, `c = floor((m - bid) * 5000 / 10000)`,
 * you receive `m - c`.
 */
export function ifOutbidAtMinimum(bid: bigint): OutbidAtMinimum {
  assertLamports(bid, 'bid');
  const nextMinimumBid = minimumBid(bid);
  const creatorShare = ((nextMinimumBid - bid) * PERCENT_PROTOCOL) / HUNDRED;
  return { nextMinimumBid, creatorShare, youReceive: nextMinimumBid - creatorShare };
}

// ---------------------------------------------------------------------------
// SOL <-> lamports, exact
// ---------------------------------------------------------------------------

/**
 * Formats lamports as a decimal SOL string with no trailing zeros:
 * `100_000_000n` → `"0.1"`, `1_000_000_000n` → `"1"`, `0n` → `"0"`.
 */
export function lamportsToSol(lamports: bigint): string {
  assertLamports(lamports, 'lamports');
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = lamports % LAMPORTS_PER_SOL;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(SOL_DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

const SOL_STRING = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a decimal SOL string to lamports exactly. Accepts only plain
 * decimals (`"0.105"`, `"1"`, `"1.0"`): no sign, exponent, whitespace or
 * separators. Rejects more than 9 decimal places, since a lamport is the
 * smallest unit, and values that do not fit a u64.
 */
export function solToLamports(sol: string): bigint {
  if (typeof sol !== 'string') {
    throw new MathError(`SOL amount must be a decimal string, got ${typeof sol}`);
  }
  const match = sol.match(SOL_STRING);
  if (!match) {
    throw new MathError(
      `SOL amount must be a plain decimal like "0.105", got ${JSON.stringify(sol)}`,
    );
  }
  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > SOL_DECIMALS) {
    throw new MathError(
      `SOL amount ${JSON.stringify(sol)} has ${frac.length} decimals; at most ${SOL_DECIMALS} are allowed (1 lamport)`,
    );
  }
  const lamports = BigInt(whole) * LAMPORTS_PER_SOL + BigInt(frac.padEnd(SOL_DECIMALS, '0'));
  if (lamports > U64_MAX) {
    throw new MathError(`SOL amount ${JSON.stringify(sol)} exceeds the u64 lamport range`);
  }
  return lamports;
}
