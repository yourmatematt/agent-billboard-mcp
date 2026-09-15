/**
 * The Definition of Done, as a test. Runs the same walk as `npm run demo`
 * (scripts/demo.ts) on MockRpc with the repo's own `intent.example.md` and
 * checks the activity log tells the story in order.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEMO_ENV,
  DEMO_LONG_MESSAGE_BYTES,
  DEMO_MESSAGE,
  OVER_LIMIT_BID_SOL,
  runDemo,
  type DemoResult,
  type DemoStep,
} from '../scripts/demo.js';
import type { ActivityEvent } from '../src/log/activity.js';
import { UNTRUSTED_BANNER } from '../src/tools/read_billboard.js';

/** The events the Definition of Done names, in order. Other lines may sit between them. */
const REQUIRED_EVENTS_IN_ORDER: ActivityEvent[] = [
  'proposed',
  'approved',
  'executed',
  'executed', // the append
  'outbid_detected',
  'refused_limit',
];

function structured(step: DemoStep): Record<string, unknown> {
  return step.structured as Record<string, unknown>;
}

function isSubsequence<T>(needle: readonly T[], haystack: readonly T[]): boolean {
  let i = 0;
  for (const item of haystack) {
    if (i < needle.length && item === needle[i]) i += 1;
  }
  return i === needle.length;
}

describe('end to end on MockRpc (Definition of Done)', () => {
  let result: DemoResult;
  const printed: string[] = [];
  const warnings: string[] = [];

  it('runs the whole demo walk without a warning', async () => {
    result = await runDemo({
      out: (line) => printed.push(line),
      warn: (line) => warnings.push(line),
      intentPath: resolve(process.cwd(), 'intent.example.md'),
    });
    expect(warnings).toEqual([]);
    expect(result.steps).toHaveLength(11);
  });

  it('read_billboard shows the banner, the 0.101 minimum, intent.example.md and the env limits', () => {
    const step = result.steps[0]!;
    expect(step.tool).toBe('read_billboard');
    expect(step.text).toContain(UNTRUSTED_BANNER);
    const read = structured(step);
    expect(read['minimum_bid_sol']).toBe('0.101');
    expect(read['you_are_poster']).toBe(false);
    const operator = read['operator'] as { intent: string | null; limits: Record<string, unknown> };
    expect(operator.intent).toContain('# Operator intent (example)');
    expect(operator.limits).toMatchObject({
      max_bid_sol: DEMO_ENV.MAX_BID_SOL,
      daily_cap_sol: DEMO_ENV.DAILY_CAP_SOL,
      auto_bid: false,
      read_only: false,
    });
  });

  it('dry_run at the minimum shows 0.1005 to the previous holder, 0.0005 to the creator, and the outbid figure', () => {
    const dry = structured(result.steps[1]!);
    expect(result.steps[1]!.args).toMatchObject({ dry_run: true });
    expect(dry['status']).toBe('dry_run');
    expect(dry['bid_sol']).toBe('0.101');
    expect(dry['previous_holder_receives_sol']).toBe('0.1005');
    expect(dry['creator_receives_sol']).toBe('0.0005');
    expect(dry['if_outbid_at_minimum_you_receive_sol']).toBe('0.101505');
    expect(dry['transactions_sent']).toBe(0);
  });

  it('the same call without dry_run returns a proposal under AUTO_BID=false', () => {
    const proposed = structured(result.steps[2]!);
    expect(proposed['status']).toBe('proposed');
    expect(proposed['transactions_sent']).toBe(0);
    expect(typeof proposed['proposal_id']).toBe('string');
  });

  it('approve_proposal executes acquire plus the first chunk in one tx and the message is set', () => {
    const approved = structured(result.steps[3]!);
    expect(approved['status']).toBe('executed');
    expect(approved['transactions_sent']).toBe(1);
    const after = structured(result.steps[4]!);
    expect(after['you_are_poster']).toBe(true);
    expect(after['message']).toBe(DEMO_MESSAGE);
  });

  it('append_message with 2000 bytes lands as three chunks in three txs with the final byte count right', () => {
    const proposed = structured(result.steps[6]!);
    expect(result.steps[6]!.tool).toBe('append_message');
    expect(Buffer.byteLength(result.steps[6]!.args['message'] as string, 'utf8')).toBe(2000);
    expect(proposed['transactions_planned']).toBe(3);
    const executed = structured(result.steps[7]!);
    expect(executed['transactions_sent']).toBe(3);
    expect((executed['billboard_after'] as { message_bytes: number }).message_bytes).toBe(
      Buffer.byteLength(DEMO_MESSAGE, 'utf8') + DEMO_LONG_MESSAGE_BYTES,
    );
  });

  it('after an outside acquire the next read shows you_are_poster false and changed_since_last_read true', () => {
    const read = structured(result.steps[8]!);
    expect(result.steps[8]!.tool).toBe('read_billboard');
    expect(read['you_are_poster']).toBe(false);
    expect(read['changed_since_last_read']).toBe(true);
    expect(read['poster']).not.toBe(result.wallet);
  });

  it('a bid of MAX_BID_SOL + 0.001 is refused with limit_exceeded and nothing is sent', () => {
    const step = result.steps[9]!;
    expect(step.args).toMatchObject({ bid_sol: OVER_LIMIT_BID_SOL });
    expect(step.isError).toBe(true);
    const refused = structured(step);
    expect(refused['error']).toBe('limit_exceeded');
    expect(refused['transactions_sent']).toBe(0);
    expect(refused['signatures']).toEqual([]);
  });

  it('get_flip_history lists the flips with hold durations', () => {
    const history = structured(result.steps[10]!);
    const flips = history['flips'] as Array<{ poster: string; held_for_seconds: number | null }>;
    expect(flips).toHaveLength(3);
    expect(flips[0]!.held_for_seconds).toBeNull();
    expect(flips[1]!.poster).toBe(result.wallet);
    expect(flips[1]!.held_for_seconds).toBeGreaterThanOrEqual(1800);
    expect(flips[2]!.held_for_seconds).toBe(3600);
    expect((history['summary'] as { flips: number }).flips).toBe(3);
  });

  it('the activity log has proposed, approved, executed, executed (append), outbid_detected, refused_limit in that order', () => {
    const events = result.activity.map((e) => e.event);
    expect(isSubsequence(REQUIRED_EVENTS_IN_ORDER, events)).toBe(true);
    // Exact sequence: append is proposed and approved too (propose mode), and
    // each of its three chunks is its own `executed` line.
    expect(events).toEqual([
      'proposed',
      'approved',
      'executed',
      'proposed',
      'approved',
      'executed',
      'executed',
      'executed',
      'outbid_detected',
      'refused_limit',
    ]);
    expect(events.filter((e) => e === 'executed')).toHaveLength(4);
    expect(events).not.toContain('failed');
    expect(events).not.toContain('expired');
  });

  it('every write in the log carries a reasoning and the refused bid has no tx', () => {
    for (const entry of result.activity) {
      if (entry.event === 'outbid_detected') {
        expect(entry.tool).toBe('billboard_reader');
        continue;
      }
      expect(typeof entry.reasoning).toBe('string');
      expect((entry.reasoning as string).length).toBeGreaterThan(0);
    }
    const executed = result.activity.filter((e) => e.event === 'executed');
    expect(executed.every((e) => typeof e.tx === 'string' && e.tx.length > 0)).toBe(true);
    const refused = result.activity.find((e) => e.event === 'refused_limit')!;
    expect(refused.tx).toBeUndefined();
    expect(refused.bid_sol).toBe(OVER_LIMIT_BID_SOL);
    expect(refused.error).toContain('limit_exceeded');
  });

  it('prints every tool call and result in order', () => {
    const headers = printed.filter((l) => /^### \d+\. /.test(l));
    expect(headers.map((h) => h.split(' ')[2])).toEqual(result.steps.map((s) => s.tool));
    expect(printed.some((l) => l.startsWith('### Activity log (10 lines'))).toBe(true);
  });
});
