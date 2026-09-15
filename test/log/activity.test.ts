import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACTIVITY_EVENTS,
  ActivityLog,
  ActivityLogError,
  MAX_REASONING_CHARS,
  activityEntrySchema,
} from '../../src/log/activity.js';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-activity-'));
  path = join(dir, 'activity.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T0 = new Date('2026-09-14T00:00:00.000Z');

function fixedClock(start: Date, stepMs = 1000): () => Date {
  let t = start.getTime();
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

describe('ActivityLog.append', () => {
  it('writes one JSON object per line and stamps ts from the clock', () => {
    const log = new ActivityLog(path, { now: fixedClock(T0) });
    const a = log.append({ event: 'proposed', tool: 'acquire_posting_rights', reasoning: 'x' });
    const b = log.append({ event: 'executed', tool: 'acquire_posting_rights', bid_sol: '0.101' });

    expect(a.ts).toBe('2026-09-14T00:00:00.000Z');
    expect(b.ts).toBe('2026-09-14T00:00:01.000Z');

    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines).toHaveLength(3); // two entries plus the trailing newline
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0] as string)).toEqual(a);
    expect(JSON.parse(lines[1] as string)).toEqual(b);
  });

  it('appends to an existing file rather than truncating it', () => {
    writeFileSync(path, '{"ts":"2026-09-13T00:00:00.000Z","event":"expired","tool":"x"}\n');
    const log = new ActivityLog(path, { now: fixedClock(T0) });
    log.append({ event: 'executed', tool: 'clear_message' });
    expect(log.entries().map((e) => e.event)).toEqual(['expired', 'executed']);
  });

  it('accepts every documented event and the full field set', () => {
    const log = new ActivityLog(path, { now: fixedClock(T0) });
    for (const event of ACTIVITY_EVENTS) {
      log.append({
        event,
        tool: 'acquire_posting_rights',
        reasoning: 'because',
        proposal_id: 'p-1',
        bid_sol: '0.101',
        tx: '5'.repeat(64),
        error: 'none',
        billboard_before: { poster: Keypair.generate().publicKey.toBase58(), amount_sol: '0.1' },
        billboard_after: { poster: Keypair.generate().publicKey.toBase58(), amount_sol: '0.101' },
      });
    }
    expect(log.entries()).toHaveLength(ACTIVITY_EVENTS.length);
  });

  it('honours an explicit ts', () => {
    const log = new ActivityLog(path, { now: fixedClock(T0) });
    const e = log.append({ ts: '2020-01-01T00:00:00.000Z', event: 'failed', tool: 'x' });
    expect(e.ts).toBe('2020-01-01T00:00:00.000Z');
  });

  it('rejects unknown events, unknown fields, bad SOL strings and long reasoning; writes nothing', () => {
    const log = new ActivityLog(path, { now: fixedClock(T0) });
    const bad: unknown[] = [
      { event: 'bought', tool: 'x' },
      { event: 'executed', tool: '' },
      { event: 'executed', tool: 'x', extra: 'nope' },
      { event: 'executed', tool: 'x', bid_sol: '0.1234567891' },
      { event: 'executed', tool: 'x', bid_sol: 0.1 },
      { event: 'executed', tool: 'x', bid_sol: '1e-3' },
      { event: 'executed', tool: 'x', reasoning: 'r'.repeat(MAX_REASONING_CHARS + 1) },
      { event: 'executed', tool: 'x', billboard_before: { poster: 'p' } },
      { event: 'executed', tool: 'x', ts: 'yesterday' },
    ];
    for (const input of bad) {
      expect(() => log.append(input as never)).toThrow(ActivityLogError);
    }
    expect(existsSync(path)).toBe(false);
  });

  it('cannot be made to write a secret key: a keypair or its bytes are rejected as unknown fields', () => {
    const kp = Keypair.generate();
    const secret = bs58.encode(kp.secretKey);
    const log = new ActivityLog(path, { now: fixedClock(T0) });

    expect(() => log.append({ event: 'executed', tool: 'x', keypair: kp } as never)).toThrow(
      ActivityLogError,
    );
    expect(() =>
      log.append({ event: 'executed', tool: 'x', secretKey: kp.secretKey } as never),
    ).toThrow(ActivityLogError);
    expect(() =>
      log.append({
        event: 'executed',
        tool: 'x',
        billboard_after: { poster: kp.publicKey.toBase58(), amount_sol: '0.1', secret },
      } as never),
    ).toThrow(ActivityLogError);

    // A legitimate entry mentioning the wallet's public key is fine and the
    // file must still not contain the secret.
    log.append({
      event: 'executed',
      tool: 'x',
      billboard_after: { poster: kp.publicKey.toBase58(), amount_sol: '0.1' },
    });
    const content = readFileSync(path, 'utf8');
    expect(content).toContain(kp.publicKey.toBase58());
    expect(content).not.toContain(secret);
    expect(content).not.toContain(JSON.stringify(Array.from(kp.secretKey)));
  });

  it('reports a filesystem failure as ActivityLogError without a partial line', () => {
    const log = new ActivityLog(join(dir, 'missing-dir', 'activity.jsonl'), {
      now: fixedClock(T0),
    });
    expect(() => log.append({ event: 'failed', tool: 'x' })).toThrow(ActivityLogError);
  });

  it('refuses an empty path', () => {
    expect(() => new ActivityLog('')).toThrow(ActivityLogError);
  });
});

describe('ActivityLog.read / entries / entriesSince', () => {
  it('treats a missing file as an empty log', () => {
    const log = new ActivityLog(path);
    expect(log.read()).toEqual({ entries: [], skipped: 0 });
    expect(log.entries()).toEqual([]);
    expect(log.entriesSince(T0)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it('skips blank, malformed and off-schema lines with a warning and keeps the rest', () => {
    writeFileSync(
      path,
      [
        '{"ts":"2026-09-14T00:00:00.000Z","event":"proposed","tool":"a"}',
        '',
        '   ',
        'this is not json',
        '{"ts":"2026-09-14T00:00:01.000Z","event":"nope","tool":"a"}',
        '{"ts":"2026-09-14T00:00:02.000Z","event":"executed","tool":"a","bid_sol":"0.1"}',
        '{"ts":"2026-09-14T00:00:03.000Z","event":"executed","tool":"a","bid_sol":"0.1"',
        '',
      ].join('\n'),
    );
    const warnings: string[] = [];
    const log = new ActivityLog(path, { warn: (m) => warnings.push(m) });
    const result = log.read();
    expect(result.entries.map((e) => e.ts)).toEqual([
      '2026-09-14T00:00:00.000Z',
      '2026-09-14T00:00:02.000Z',
    ]);
    expect(result.skipped).toBe(3);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('line 4');
    expect(warnings[1]).toContain('line 5');
    expect(warnings[2]).toContain('line 7');
  });

  it('entriesSince is inclusive at the cutoff and accepts Date, ms or ISO string', () => {
    const log = new ActivityLog(path, { now: fixedClock(T0, 60_000) });
    log.append({ event: 'executed', tool: 'a' }); // 00:00
    log.append({ event: 'executed', tool: 'b' }); // 00:01
    log.append({ event: 'executed', tool: 'c' }); // 00:02

    const cutoff = new Date('2026-09-14T00:01:00.000Z');
    expect(log.entriesSince(cutoff).map((e) => e.tool)).toEqual(['b', 'c']);
    expect(log.entriesSince(cutoff.getTime()).map((e) => e.tool)).toEqual(['b', 'c']);
    expect(log.entriesSince(cutoff.toISOString()).map((e) => e.tool)).toEqual(['b', 'c']);
    expect(log.entriesSince(cutoff.getTime() + 1).map((e) => e.tool)).toEqual(['c']);
    expect(() => log.entriesSince('not a date')).toThrow(ActivityLogError);
  });

  it('round-trips through the schema exactly', () => {
    const log = new ActivityLog(path, { now: fixedClock(T0) });
    const written = log.append({
      event: 'refused_limit',
      tool: 'acquire_posting_rights',
      reasoning: 'worth a go',
      bid_sol: '5',
      error: 'limit_exceeded: max_bid',
    });
    const [read] = log.entries();
    expect(read).toEqual(written);
    expect(activityEntrySchema.safeParse(read).success).toBe(true);
  });
});
