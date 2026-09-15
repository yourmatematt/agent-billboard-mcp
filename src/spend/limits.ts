/**
 * Spend limits: MAX_BID and DAILY_CAP, enforced in code before anything is
 * signed.
 *
 * The daily figure is computed from the activity log, not from memory, so
 * a restart cannot reset the allowance. Only `executed` entries carrying a
 * `bid_sol` count: that is the gross amount that left the wallet. Proposed,
 * refused, failed and expired entries never count. Refunds received later
 * (when someone outbids us) do not restore allowance either; the cap is on
 * what we send, not on what we keep.
 *
 * The window is rolling: an entry counts while it is at most 24 hours old
 * (inclusive at the boundary, which is the conservative side).
 *
 * All arithmetic is in lamports as `bigint`. Figures leave as SOL strings.
 */
import type { ActivityLog } from '../log/activity.js';
import { lamportsToSol, solToLamports } from '../program/math.js';

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export class LimitsError extends Error {
  override readonly name = 'LimitsError';
  constructor(message: string) {
    super(message);
  }
}

export interface SpendFigures {
  bid_sol: string;
  max_bid_sol: string;
  daily_cap_sol: string;
  spent_last_24h_sol: string;
  remaining_today_sol: string;
}

export type LimitReason = 'max_bid' | 'daily_cap';

export type LimitCheck =
  | ({ ok: true } & SpendFigures)
  | ({ ok: false; reason: LimitReason; message: string } & SpendFigures);

export interface LimitSummary {
  max_bid_sol: string;
  daily_cap_sol: string;
  spent_last_24h_sol: string;
  remaining_today_sol: string;
}

export interface SpendLimitsOptions {
  /** Clock. Injectable for tests. Default `() => new Date()`. */
  now?: () => Date;
}

export class SpendLimits {
  readonly maxBidLamports: bigint;
  readonly dailyCapLamports: bigint;
  private readonly log: ActivityLog;
  private readonly now: () => Date;

  constructor(
    log: ActivityLog,
    limits: { maxBidLamports: bigint; dailyCapLamports: bigint },
    options: SpendLimitsOptions = {},
  ) {
    assertLamports(limits.maxBidLamports, 'maxBidLamports');
    assertLamports(limits.dailyCapLamports, 'dailyCapLamports');
    this.log = log;
    this.maxBidLamports = limits.maxBidLamports;
    this.dailyCapLamports = limits.dailyCapLamports;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Gross lamports sent as bids in the last 24 hours, from `executed`
   * entries in the activity log.
   */
  spentLast24h(): bigint {
    const cutoff = this.now().getTime() - WINDOW_MS;
    let total = 0n;
    for (const entry of this.log.entriesSince(cutoff)) {
      if (entry.event !== 'executed' || entry.bid_sol === undefined) continue;
      total += solToLamports(entry.bid_sol);
    }
    return total;
  }

  /** Lamports still available under the daily cap. Never negative. */
  remainingToday(): bigint {
    const remaining = this.dailyCapLamports - this.spentLast24h();
    return remaining < 0n ? 0n : remaining;
  }

  /** The figures `read_billboard` reports under `operator.limits`. */
  summary(): LimitSummary {
    const spent = this.spentLast24h();
    const remaining = this.dailyCapLamports - spent;
    return {
      max_bid_sol: lamportsToSol(this.maxBidLamports),
      daily_cap_sol: lamportsToSol(this.dailyCapLamports),
      spent_last_24h_sol: lamportsToSol(spent),
      remaining_today_sol: lamportsToSol(remaining < 0n ? 0n : remaining),
    };
  }

  /**
   * Would a bid of `bidLamports` be allowed right now? Checks MAX_BID first,
   * then the rolling daily cap. A bid that lands exactly on either limit is
   * allowed. This is a pure check: it does not record anything.
   */
  checkBid(bidLamports: bigint): LimitCheck {
    assertLamports(bidLamports, 'bid');
    const spent = this.spentLast24h();
    const remaining = this.dailyCapLamports - spent;
    const figures: SpendFigures = {
      bid_sol: lamportsToSol(bidLamports),
      max_bid_sol: lamportsToSol(this.maxBidLamports),
      daily_cap_sol: lamportsToSol(this.dailyCapLamports),
      spent_last_24h_sol: lamportsToSol(spent),
      remaining_today_sol: lamportsToSol(remaining < 0n ? 0n : remaining),
    };

    if (bidLamports > this.maxBidLamports) {
      return {
        ok: false,
        reason: 'max_bid',
        message: `bid ${figures.bid_sol} SOL exceeds MAX_BID_SOL ${figures.max_bid_sol}`,
        ...figures,
      };
    }
    if (spent + bidLamports > this.dailyCapLamports) {
      return {
        ok: false,
        reason: 'daily_cap',
        message:
          `bid ${figures.bid_sol} SOL would take the last 24 hours to ` +
          `${lamportsToSol(spent + bidLamports)} SOL, over DAILY_CAP_SOL ${figures.daily_cap_sol} ` +
          `(spent ${figures.spent_last_24h_sol}, remaining ${figures.remaining_today_sol})`,
        ...figures,
      };
    }
    return { ok: true, ...figures };
  }
}

function assertLamports(value: bigint, label: string): void {
  if (typeof value !== 'bigint') {
    throw new LimitsError(`${label} must be a bigint (lamports), got ${typeof value}`);
  }
  if (value < 0n) {
    throw new LimitsError(`${label} must not be negative, got ${value}`);
  }
}
