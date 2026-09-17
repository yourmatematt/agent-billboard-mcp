import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEMO_LONG_MESSAGE,
  DEMO_LONG_MESSAGE_BYTES,
  DEMO_MESSAGE,
  LOOP_BID_SOL,
  LOOP_RIVAL_BID_SOL,
  OVER_LIMIT_BID_SOL,
  RIVAL_BID_SOL,
  RIVAL_MESSAGE,
  runDemo,
  type DemoResult,
  type DemoStep,
} from '../scripts/demo.js';
import { UNTRUSTED_BANNER } from '../src/tools/read_billboard.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-demo-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DEMO_MESSAGE_BYTES = Buffer.byteLength(DEMO_MESSAGE, 'utf8');

function structured(step: DemoStep): Record<string, unknown> {
  return step.structured as Record<string, unknown>;
}

describe('scripts/demo.ts', () => {
  it('builds a long message of exactly 2000 bytes and an over-limit bid of MAX_BID_SOL + 0.001', () => {
    expect(Buffer.byteLength(DEMO_LONG_MESSAGE, 'utf8')).toBe(DEMO_LONG_MESSAGE_BYTES);
    expect(DEMO_LONG_MESSAGE_BYTES).toBe(2000);
    expect(OVER_LIMIT_BID_SOL).toBe('0.201');
  });

  it('walks the Definition of Done on MockRpc and prints each result', async () => {
    const intentPath = join(dir, 'intent.md');
    writeFileSync(intentPath, 'Demo intent: post the bakery opening hours.\n');
    const lines: string[] = [];
    const warnings: string[] = [];
    const result = await runDemo({
      out: (l) => lines.push(l),
      warn: (w) => warnings.push(w),
      intentPath,
    });

    expect(result.steps.map((s) => s.tool)).toEqual([
      'read_billboard',
      'acquire_posting_rights',
      'acquire_posting_rights',
      'approve_proposal',
      'read_billboard',
      'get_flip_history',
      'append_message',
      'approve_proposal',
      'read_billboard',
      'acquire_posting_rights',
      'get_flip_history',
    ]);
    // Only the over-limit bid is an error result.
    expect(result.steps.map((s) => s.isError)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
    ]);

    const read = structured(result.steps[0]!);
    expect(read['minimum_bid_sol']).toBe('0.101');
    expect(read['amount_sol']).toBe('0.1');
    expect(read['you_are_poster']).toBe(false);
    expect((read['operator'] as { intent: string | null }).intent).toContain('bakery');
    expect(result.steps[0]!.text).toContain(UNTRUSTED_BANNER);

    const dry = structured(result.steps[1]!);
    expect(dry['status']).toBe('dry_run');
    expect(dry['bid_sol']).toBe('0.101');
    expect(dry['previous_holder_receives_sol']).toBe('0.1005');
    expect(dry['creator_receives_sol']).toBe('0.0005');

    // Propose mode: the write tool signs nothing and returns a proposal ...
    const proposed = structured(result.steps[2]!);
    expect(proposed['status']).toBe('proposed');
    expect(proposed['bid_sol']).toBe('0.101');
    expect(proposed['transactions_sent']).toBe(0);
    expect(typeof proposed['proposal_id']).toBe('string');

    // ... and approve_proposal signs it: acquire + first chunk in one transaction.
    const approved = structured(result.steps[3]!);
    expect(result.steps[3]!.args).toEqual({ proposal_id: proposed['proposal_id'] });
    expect(approved['status']).toBe('executed');
    expect(approved['transactions_sent']).toBe(1);
    expect(approved['billboard_after']).toMatchObject({
      poster: result.wallet,
      amount_sol: '0.101',
      message_bytes: DEMO_MESSAGE_BYTES,
      you_are_poster: true,
    });

    const after = structured(result.steps[4]!);
    expect(after['you_are_poster']).toBe(true);
    expect(after['changed_since_last_read']).toBe(true);
    expect(after['amount_sol']).toBe('0.101');
    expect(after['message']).toBe(DEMO_MESSAGE);

    const history = structured(result.steps[5]!);
    expect((history['flips'] as unknown[]).length).toBe(2);

    // The 2000-byte append: proposed, then approved as three transactions.
    const appendProposed = structured(result.steps[6]!);
    expect(appendProposed['status']).toBe('proposed');
    expect(appendProposed['transactions_planned']).toBe(3);
    expect(appendProposed['transactions_sent']).toBe(0);
    const appendApproved = structured(result.steps[7]!);
    expect(result.steps[7]!.args).toEqual({ proposal_id: appendProposed['proposal_id'] });
    expect(appendApproved['status']).toBe('executed');
    expect(appendApproved['transactions_sent']).toBe(3);
    expect((appendApproved['signatures'] as string[]).length).toBe(3);
    expect(appendApproved['billboard_after']).toMatchObject({
      poster: result.wallet,
      message_bytes: DEMO_MESSAGE_BYTES + DEMO_LONG_MESSAGE_BYTES,
      you_are_poster: true,
    });

    // After the outside acquire the agent is no longer the poster.
    const outbid = structured(result.steps[8]!);
    expect(outbid['you_are_poster']).toBe(false);
    expect(outbid['changed_since_last_read']).toBe(true);
    expect(outbid['amount_sol']).toBe(RIVAL_BID_SOL);
    expect(outbid['message']).toBe(RIVAL_MESSAGE);
    expect(outbid['poster']).not.toBe(result.wallet);

    // The over-limit bid is refused before anything is proposed or signed.
    const refused = structured(result.steps[9]!);
    expect(result.steps[9]!.args).toMatchObject({ bid_sol: OVER_LIMIT_BID_SOL });
    expect(refused['status']).toBe('refused');
    expect(refused['error']).toBe('limit_exceeded');
    expect(refused['transactions_sent']).toBe(0);
    expect((refused['limits'] as { reason: string }).reason).toBe('max_bid');

    const finalHistory = structured(result.steps[10]!);
    const flips = finalHistory['flips'] as Array<{ held_for_seconds: number | null }>;
    expect(flips.length).toBe(3);
    expect(flips[0]!.held_for_seconds).toBeNull();
    expect(flips[1]!.held_for_seconds).toBeGreaterThanOrEqual(1800);
    expect(flips[2]!.held_for_seconds).toBe(3600);

    expect(result.activity.map((e) => e.event)).toEqual([
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
    // Every write carries the reasoning; outbid_detected is the reader's own entry.
    expect(
      result.activity
        .filter((e) => e.event !== 'outbid_detected')
        .every((e) => typeof e.reasoning === 'string' && e.reasoning.length > 0),
    ).toBe(true);
    expect(result.activity[2]!.tx).toBe((approved['signatures'] as string[])[0]);
    expect(warnings).toEqual([]);

    // Every step is announced in order, structured output is printed, and the
    // activity log is echoed one JSON object per line.
    const headers = lines.filter((l) => /^### \d+\. /.test(l));
    expect(headers).toHaveLength(11);
    expect(headers[0]).toContain('1. read_billboard');
    expect(headers[10]).toContain('11. get_flip_history');
    expect(lines.some((l) => l.startsWith('### (not a tool call) outside acquire'))).toBe(true);
    expect(lines.filter((l) => l === 'structuredContent:')).toHaveLength(
      result.steps.length + result.loopSteps.length,
    );
    const logHeader = lines.findIndex((l) => l.startsWith('### Activity log (10 lines'));
    expect(logHeader).toBeGreaterThan(0);
    expect(JSON.parse(lines[logHeader + 1]!)).toMatchObject({ event: 'proposed' });
    expect(JSON.parse(lines[logHeader + 10]!)).toMatchObject({ event: 'refused_limit' });
  });

  it('prints an "on a loop" segment: five wakes, one approval, one supersession, one expiry', async () => {
    const intentPath = join(dir, 'intent.md');
    writeFileSync(intentPath, 'Demo intent: post the bakery opening hours.\n');
    const lines: string[] = [];
    const warnings: string[] = [];
    const result: DemoResult = await runDemo({
      out: (l) => lines.push(l),
      warn: (w) => warnings.push(w),
      intentPath,
    });
    expect(warnings).toEqual([]);

    // The loop segment is kept out of `steps` so the Definition of Done walk
    // above stays one unit; it has its own calls and its own log lines.
    expect(result.steps).toHaveLength(11);
    expect(result.loopSteps.map((s) => s.tool)).toEqual([
      'read_billboard',
      'read_billboard',
      'acquire_posting_rights',
      'approve_proposal',
      'append_message',
      'append_message',
      'approve_proposal',
      'approve_proposal',
    ]);
    // Only the two refused approvals are errors.
    expect(result.loopSteps.map((s) => s.isError)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);

    // Wake 1: the board has not moved, so the agent stops.
    const quiet = structured(result.loopSteps[0]!);
    expect(quiet['changed_since_last_read']).toBe(false);

    // Wake 2: a second rival took it, so the read shows the move and the
    // agent proposes the minimum over their bid.
    const moved = structured(result.loopSteps[1]!);
    expect(moved['changed_since_last_read']).toBe(true);
    expect(moved['amount_sol']).toBe(LOOP_RIVAL_BID_SOL);
    expect(moved['minimum_bid_sol']).toBe(LOOP_BID_SOL);
    const loopProposal = structured(result.loopSteps[2]!);
    expect(loopProposal['status']).toBe('proposed');
    expect(loopProposal['bid_sol']).toBe(LOOP_BID_SOL);
    expect(loopProposal['transactions_sent']).toBe(0);

    // Wake 3: approved half an hour later, inside PROPOSAL_TTL_MIN.
    const loopApproval = structured(result.loopSteps[3]!);
    expect(loopApproval['status']).toBe('executed');
    expect(loopApproval['proposal_id']).toBe(loopProposal['proposal_id']);
    expect(loopApproval['billboard_after']).toMatchObject({
      poster: result.wallet,
      amount_sol: LOOP_BID_SOL,
      you_are_poster: true,
    });

    // Wake 4: the second draft replaces the first for the same tool, and the
    // older id can no longer be approved.
    const firstDraft = structured(result.loopSteps[4]!);
    const secondDraft = structured(result.loopSteps[5]!);
    expect(firstDraft['status']).toBe('proposed');
    expect(secondDraft['status']).toBe('proposed');
    const supersededRefusal = structured(result.loopSteps[6]!);
    expect(supersededRefusal['status']).toBe('refused');
    expect(supersededRefusal['error']).toBe('superseded');
    expect(supersededRefusal['proposal_id']).toBe(firstDraft['proposal_id']);
    expect(supersededRefusal['superseded_by']).toBe(secondDraft['proposal_id']);

    // Wake 5: an hour on, nobody answered the open one.
    const expiredRefusal = structured(result.loopSteps[7]!);
    expect(expiredRefusal['status']).toBe('refused');
    expect(expiredRefusal['error']).toBe('expired');
    expect(expiredRefusal['proposal_id']).toBe(secondDraft['proposal_id']);
    expect(expiredRefusal['transactions_sent']).toBe(0);

    expect(result.loopActivity.map((e) => e.event)).toEqual([
      'proposed',
      'approved',
      'executed',
      'proposed',
      'superseded',
      'proposed',
      'expired',
    ]);
    const superseded = result.loopActivity[4]!;
    expect(superseded.proposal_id).toBe(firstDraft['proposal_id']);
    expect(superseded.superseded_by).toBe(secondDraft['proposal_id']);
    // The walk's own log is untouched by the segment that follows it.
    expect(result.activity).toHaveLength(10);

    // Loop calls are headed by wake, not by step number, so the walk's
    // numbering stays readable.
    expect(lines.filter((l) => /^### wake \d+: /.test(l))).toHaveLength(8);
    expect(lines.filter((l) => /^### \d+\. /.test(l))).toHaveLength(11);
    expect(lines).toContain('## On a loop');
    expect(lines.some((l) => l.startsWith('### Activity log from the loop segment (7 lines'))).toBe(
      true,
    );
  });

  it('warns rather than fails when the intent file is missing', async () => {
    const warnings: string[] = [];
    const result = await runDemo({
      out: () => undefined,
      warn: (w) => warnings.push(w),
      intentPath: join(dir, 'nope.md'),
    });
    expect(warnings.some((w) => w.includes('no intent file'))).toBe(true);
    expect((structured(result.steps[0]!)['operator'] as { intent: null }).intent).toBeNull();
  });
});
