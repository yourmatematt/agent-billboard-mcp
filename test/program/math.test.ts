import { describe, expect, it } from 'vitest';
import {
  LAMPORTS_PER_SOL,
  MathError,
  SOL_DECIMALS,
  ifOutbidAtMinimum,
  lamportsToSol,
  minimumBid,
  solToLamports,
  splitOnAcquire,
} from '../../src/program/math.js';

const SOL = LAMPORTS_PER_SOL;

describe('minimumBid', () => {
  it('0.1 SOL → 0.101 SOL (1% over, integer lamports)', () => {
    expect(minimumBid(100_000_000n)).toBe(101_000_000n);
  });

  it('rounds down, never up', () => {
    // 1 * 10100 / 10000 = 1.01 → 1
    expect(minimumBid(1n)).toBe(1n);
    // 99 * 10100 / 10000 = 99.99 → 99
    expect(minimumBid(99n)).toBe(99n);
    // 150 * 10100 / 10000 = 151.5 → 151
    expect(minimumBid(150n)).toBe(151n);
    // 100 * 10100 / 10000 = 101 exactly
    expect(minimumBid(100n)).toBe(101n);
  });

  it('first post: minimum over zero is zero (the program has no floor)', () => {
    expect(minimumBid(0n)).toBe(0n);
  });

  it('matches the program formula for a large amount', () => {
    const current = 123_456_789_012n; // ~123 SOL
    expect(minimumBid(current)).toBe((current * 10_100n) / 10_000n);
  });

  it('rejects negatives and non-bigints', () => {
    expect(() => minimumBid(-1n)).toThrow(MathError);
    expect(() => minimumBid(1 as unknown as bigint)).toThrow(MathError);
  });
});

describe('splitOnAcquire', () => {
  it('0.1 → 0.101: previous holder gets 0.1005, creator gets 0.0005', () => {
    const split = splitOnAcquire(100_000_000n, 101_000_000n);
    expect(split.creatorShare).toBe(500_000n);
    expect(split.prevPosterReceives).toBe(100_500_000n);
    expect(split.creatorShare + split.prevPosterReceives).toBe(101_000_000n);
  });

  it('first post: the whole amount goes to the creator', () => {
    const split = splitOnAcquire(0n, 50_000_000n);
    expect(split.creatorShare).toBe(50_000_000n);
    expect(split.prevPosterReceives).toBe(0n);
  });

  it('odd differences round the creator share down; the sum is always the bid', () => {
    const split = splitOnAcquire(100n, 103n); // difference 3 → creator 1, prev 102
    expect(split.creatorShare).toBe(1n);
    expect(split.prevPosterReceives).toBe(102n);
    expect(split.creatorShare + split.prevPosterReceives).toBe(103n);
  });

  it('bidding well above the minimum splits the excess 50/50', () => {
    const split = splitOnAcquire(1n * SOL, 3n * SOL);
    expect(split.creatorShare).toBe(1n * SOL);
    expect(split.prevPosterReceives).toBe(2n * SOL);
  });

  it('refuses a bid below the minimum (the program would reject it with error 6000)', () => {
    expect(() => splitOnAcquire(100_000_000n, 100_999_999n)).toThrow(MathError);
    expect(() => splitOnAcquire(100_000_000n, 50_000_000n)).toThrow(MathError);
  });

  it('rejects negatives', () => {
    expect(() => splitOnAcquire(-1n, 1n)).toThrow(MathError);
    expect(() => splitOnAcquire(0n, -1n)).toThrow(MathError);
  });
});

describe('ifOutbidAtMinimum', () => {
  it('0.1 SOL bid: next minimum 0.101, creator 0.0005, you receive 0.1005', () => {
    const r = ifOutbidAtMinimum(100_000_000n);
    expect(r.nextMinimumBid).toBe(101_000_000n);
    expect(r.creatorShare).toBe(500_000n);
    expect(r.youReceive).toBe(100_500_000n);
  });

  it('0.101 SOL bid: next minimum 0.10201, you receive 0.101505', () => {
    const r = ifOutbidAtMinimum(101_000_000n);
    expect(r.nextMinimumBid).toBe(102_010_000n);
    expect(r.creatorShare).toBe(505_000n);
    expect(r.youReceive).toBe(101_505_000n);
  });

  it('agrees with splitOnAcquire applied to the next minimum', () => {
    const bid = 777_777_777n;
    const r = ifOutbidAtMinimum(bid);
    const split = splitOnAcquire(bid, r.nextMinimumBid);
    expect(r.creatorShare).toBe(split.creatorShare);
    expect(r.youReceive).toBe(split.prevPosterReceives);
  });

  it('a tiny bid can be outbid at the same amount and returns it in full', () => {
    // minimumBid(1) = 1, so m - bid = 0 and the holder gets exactly 1 back.
    const r = ifOutbidAtMinimum(1n);
    expect(r.nextMinimumBid).toBe(1n);
    expect(r.creatorShare).toBe(0n);
    expect(r.youReceive).toBe(1n);
  });
});

describe('lamportsToSol', () => {
  it('formats exact decimals with trailing zeros stripped', () => {
    expect(SOL_DECIMALS).toBe(9);
    expect(LAMPORTS_PER_SOL).toBe(1_000_000_000n);
    expect(lamportsToSol(0n)).toBe('0');
    expect(lamportsToSol(1n)).toBe('0.000000001');
    expect(lamportsToSol(500_000n)).toBe('0.0005');
    expect(lamportsToSol(100_000_000n)).toBe('0.1');
    expect(lamportsToSol(100_500_000n)).toBe('0.1005');
    expect(lamportsToSol(101_000_000n)).toBe('0.101');
    expect(lamportsToSol(1_000_000_000n)).toBe('1');
    expect(lamportsToSol(1_000_000_001n)).toBe('1.000000001');
    expect(lamportsToSol(123_456_789_012n)).toBe('123.456789012');
    expect(lamportsToSol(18_446_744_073_709_551_615n)).toBe('18446744073.709551615');
  });

  it('rejects negatives and JS numbers', () => {
    expect(() => lamportsToSol(-1n)).toThrow(MathError);
    expect(() => lamportsToSol(1 as unknown as bigint)).toThrow(MathError);
  });
});

describe('solToLamports', () => {
  it('parses exact decimal strings', () => {
    expect(solToLamports('0')).toBe(0n);
    expect(solToLamports('0.1')).toBe(100_000_000n);
    expect(solToLamports('0.101')).toBe(101_000_000n);
    expect(solToLamports('0.1005')).toBe(100_500_000n);
    expect(solToLamports('1')).toBe(1_000_000_000n);
    expect(solToLamports('1.0')).toBe(1_000_000_000n);
    expect(solToLamports('1.000000000')).toBe(1_000_000_000n);
    expect(solToLamports('0.000000001')).toBe(1n);
    expect(solToLamports('00.10')).toBe(100_000_000n);
    expect(solToLamports('123.456789012')).toBe(123_456_789_012n);
  });

  it('is exact where floating point is not', () => {
    // 0.1 + 0.2 !== 0.3 in floats; in lamports it is exact.
    expect(solToLamports('0.1') + solToLamports('0.2')).toBe(solToLamports('0.3'));
    expect(solToLamports('0.3')).toBe(300_000_000n);
  });

  it('rejects more than 9 decimals (sub-lamport precision)', () => {
    expect(() => solToLamports('0.0000000001')).toThrow(MathError);
    expect(() => solToLamports('1.1234567891')).toThrow(MathError);
    expect(() => solToLamports('0.000000000000')).toThrow(MathError);
  });

  it('rejects anything that is not a plain decimal', () => {
    const bad = [
      '',
      ' ',
      'abc',
      '1e3',
      '1E-3',
      '-1',
      '+1',
      '0x10',
      '1.',
      '.5',
      '1,5',
      '1 SOL',
      'NaN',
      'Infinity',
      '1_000',
      ' 1',
      '1\n',
    ];
    for (const s of bad) {
      expect(() => solToLamports(s), JSON.stringify(s)).toThrow(MathError);
    }
    expect(() => solToLamports(0.1 as unknown as string)).toThrow(MathError);
  });

  it('rejects values that do not fit a u64', () => {
    expect(solToLamports('18446744073.709551615')).toBe(18_446_744_073_709_551_615n);
    expect(() => solToLamports('18446744073.709551616')).toThrow(MathError);
  });

  it('round-trips lamports → string → lamports', () => {
    for (const x of [0n, 1n, 999n, 100_000_000n, 100_500_000n, 1_000_000_000n, 987_654_321_000n]) {
      expect(solToLamports(lamportsToSol(x))).toBe(x);
    }
  });

  it('round-trips string → lamports → canonical string', () => {
    expect(lamportsToSol(solToLamports('0.100'))).toBe('0.1');
    expect(lamportsToSol(solToLamports('1.0'))).toBe('1');
    expect(lamportsToSol(solToLamports('0.105'))).toBe('0.105');
  });
});
