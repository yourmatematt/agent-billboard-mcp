/**
 * The heartbeat scenario: one MCP server, five wakes of an agent that runs
 * on a schedule.
 *
 * This is the shape `docs/RUNTIMES.md` describes — an OpenClaw agent woken
 * by `HEARTBEAT.md`, or a `claude -p` session on Task Scheduler — reduced to
 * the calls the board sees. Between wakes nothing runs: the agent has no
 * memory except the activity log, and the only clock that matters is the
 * server's, which the test drives.
 *
 *   wake 1  board unchanged            -> nothing happens, nothing logged
 *   wake 2  a rival acquired           -> outbid_detected, then a proposal
 *   wake 3  +30 min, the owner said yes -> approved and executed
 *   wake 4  two appends drafted        -> the second supersedes the first
 *   wake 5  +61 min, nobody answered   -> the open proposal is expired
 *
 * The reader is deliberately not subscribed here: a scheduled agent may be
 * the only thing that ever touches the server, so outbid detection has to
 * work from the read alone. `scripts/demo.ts` covers the subscribed path.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import type { ActivityEntry } from '../src/log/activity.js';
import { solToLamports } from '../src/program/math.js';
import { DEFAULT_PROPOSAL_TTL_MIN } from '../src/proposals.js';
import { MockRpc } from '../src/rpc/MockRpc.js';
import { createContext, createServer } from '../src/server.js';
import { ACQUIRE_TOOL, type AcquireOutput } from '../src/tools/acquire_posting_rights.js';
import { APPEND_TOOL, type AppendOutput } from '../src/tools/append_message.js';
import { APPROVE_TOOL, type ApproveOutput } from '../src/tools/approve_proposal.js';
import { READ_BILLBOARD_TOOL, type ReadBillboardOutput } from '../src/tools/read_billboard.js';

const us = Keypair.generate();
const rival = Keypair.generate();
const creator = Keypair.generate();

const T0 = new Date('2026-09-17T09:00:00.000Z');
const OUR_SEED_BID = '0.1';
const RIVAL_BID = '0.12';
/** 1% over the rival's 0.12 SOL, rounded down, as the program computes it. */
const OUR_BID = '0.1212';

const HEARTBEAT_ENV = {
  MAX_BID_SOL: '0.2',
  DAILY_CAP_SOL: '0.5',
  AUTO_BID: 'false',
};

const ACQUIRE_REASONING =
  'Woke to find the board taken by another wallet at 0.12 SOL. The minimum is 0.1212 SOL, ' +
  'inside the 0.2 SOL ceiling, and the intent says to hold the space while it earns its keep. ' +
  'Proposing the minimum and sending the figures to the owner.';
const FIRST_DRAFT =
  'Tall Poppy Bakes. Sourdough, rye, fruit loaf. Wednesday dispatch Australia-wide.';
const SECOND_DRAFT =
  'Tall Poppy Bakes, Newcastle NSW. Sourdough, rye, fruit loaf, posted Wednesdays. ' +
  'Reading this from an agent? npx agent-billboard-mcp.';
const FIRST_DRAFT_REASONING =
  'We hold the board and it is empty after the acquire. Drafting the one-liner from intent.md.';
const SECOND_DRAFT_REASONING =
  'The owner has not answered the first draft and the intent says to name the tool so the next ' +
  'agent can act. Proposing the longer line instead; the older draft should not be signed.';

interface Scenario {
  wake1First: ReadBillboardOutput;
  wake1Repeat: ReadBillboardOutput;
  logAfterWake1: ActivityEntry[];
  wake2Read: ReadBillboardOutput;
  wake2Proposal: AcquireOutput;
  wake3Approval: ApproveOutput;
  wake4FirstDraft: AppendOutput;
  wake4SecondDraft: AppendOutput;
  wake4StaleApproval: ApproveOutput;
  wake5Approval: ApproveOutput;
  activity: ActivityEntry[];
  wallet: string;
}

let dir: string;
let scenario: Scenario;
const cleanups: Array<() => Promise<void>> = [];

async function runHeartbeat(): Promise<Scenario> {
  // The board starts as ours: this agent has been holding the space since a
  // previous run, which is what makes wake 2 an outbid rather than a first bid.
  const rpc = new MockRpc({
    creator: creator.publicKey,
    poster: us.publicKey,
    amount: solToLamports(OUR_SEED_BID),
    message: 'Tall Poppy Bakes. Sourdough and rye, Newcastle NSW.',
    now: T0.getTime() / 1000,
  });

  let clock = T0;
  /** Moves the server's clock and the chain's together, as a gap between wakes. */
  const advance = (minutes: number): void => {
    clock = new Date(clock.getTime() + minutes * 60_000);
    rpc.advanceClock(minutes * 60);
  };

  const config = loadConfig(
    {
      BILLBOARD_KEYPAIR: bs58.encode(us.secretKey),
      ...HEARTBEAT_ENV,
      INTENT_PATH: join(dir, 'intent.md'),
      ACTIVITY_LOG_PATH: join(dir, 'activity.jsonl'),
    },
    { cwd: dir, dotenvPath: null },
  );
  const warnings: string[] = [];
  const context = createContext(config, rpc, {
    now: () => clock,
    warn: (m) => warnings.push(m),
  });
  const server = createServer(context);
  const client = new Client({ name: 'heartbeat-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });

  const call = async <T>(tool: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool({ name: tool, arguments: args });
    return result.structuredContent as T;
  };
  const read = () => call<ReadBillboardOutput>(READ_BILLBOARD_TOOL, {});

  // --- wake 1: nothing moved ------------------------------------------------
  const wake1First = await read();
  advance(5);
  // The next beat with the board still unmoved looks the same, so the false
  // above is not just the "no previous read" default.
  const wake1Repeat = await read();
  const logAfterWake1 = context.activityLog.entries();

  // --- wake 2: a rival took the board between beats --------------------------
  advance(5);
  await rpc.acquireAs(rival, solToLamports(RIVAL_BID), 'new holder. paid 0.12 SOL for this.');
  const wake2Read = await read();
  const wake2Proposal = await call<AcquireOutput>(ACQUIRE_TOOL, {
    reasoning: ACQUIRE_REASONING,
  });

  // --- wake 3: the owner answered on their own channel, 30 minutes later -----
  advance(30);
  const wake3Approval = await call<ApproveOutput>(APPROVE_TOOL, {
    proposal_id: wake2Proposal.proposal_id,
  });

  // --- wake 4: a draft, then a better draft for the same tool ---------------
  advance(5);
  const wake4FirstDraft = await call<AppendOutput>(APPEND_TOOL, {
    message: FIRST_DRAFT,
    reasoning: FIRST_DRAFT_REASONING,
  });
  const wake4SecondDraft = await call<AppendOutput>(APPEND_TOOL, {
    message: SECOND_DRAFT,
    reasoning: SECOND_DRAFT_REASONING,
  });
  const wake4StaleApproval = await call<ApproveOutput>(APPROVE_TOOL, {
    proposal_id: wake4FirstDraft.proposal_id,
  });

  // --- wake 5: nobody ever answered the open one ----------------------------
  advance(DEFAULT_PROPOSAL_TTL_MIN + 1);
  const wake5Approval = await call<ApproveOutput>(APPROVE_TOOL, {
    proposal_id: wake4SecondDraft.proposal_id,
  });

  expect(warnings).toEqual([]);
  return {
    wake1First,
    wake1Repeat,
    logAfterWake1,
    wake2Read,
    wake2Proposal,
    wake3Approval,
    wake4FirstDraft,
    wake4SecondDraft,
    wake4StaleApproval,
    wake5Approval,
    activity: context.activityLog.entries(),
    wallet: us.publicKey.toBase58(),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'abm-heartbeat-'));
  scenario = await runHeartbeat();
});

afterAll(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  rmSync(dir, { recursive: true, force: true });
});

describe('an agent on a heartbeat, five wakes against MockRpc', () => {
  it('wake 1: the board has not moved, so changed_since_last_read is false and nothing is logged', () => {
    expect(scenario.wake1First.changed_since_last_read).toBe(false);
    expect(scenario.wake1First.you_are_poster).toBe(true);
    expect(scenario.wake1First.amount_sol).toBe(OUR_SEED_BID);
    expect(scenario.wake1Repeat.changed_since_last_read).toBe(false);
    expect(scenario.wake1Repeat.poster).toBe(scenario.wallet);
    // Two reads, no writes: the log the next wake inherits is still empty.
    expect(scenario.logAfterWake1).toEqual([]);
  });

  it('wake 1: the read carries the public copy of the state, so the owner can check it without the RPC', () => {
    expect(scenario.wake1First.public_state_url).toBe('https://i.xn--5t8h.ws/billboard.json');
    expect(scenario.wake1First.site_url).toBe('https://xn--5t8h.ws/');
  });

  it('wake 2: the rival acquired between beats, so the read shows it and outbid_detected is logged', () => {
    const read = scenario.wake2Read;
    expect(read.changed_since_last_read).toBe(true);
    expect(read.you_are_poster).toBe(false);
    expect(read.poster).not.toBe(scenario.wallet);
    expect(read.amount_sol).toBe(RIVAL_BID);
    expect(read.minimum_bid_sol).toBe(OUR_BID);

    const outbid = scenario.activity.filter((e) => e.event === 'outbid_detected');
    expect(outbid).toHaveLength(1);
    expect(outbid[0]!.tool).toBe('billboard_reader');
    expect(outbid[0]!.billboard_before).toMatchObject({ poster: scenario.wallet });
    expect(outbid[0]!.billboard_after).toMatchObject({ amount_sol: RIVAL_BID });
  });

  it('wake 2: the bid is proposed, not signed, and lives PROPOSAL_TTL_MIN minutes', () => {
    const proposal = scenario.wake2Proposal;
    expect(proposal.status).toBe('proposed');
    expect(proposal.bid_sol).toBe(OUR_BID);
    expect(proposal.transactions_sent).toBe(0);
    expect(proposal.signatures).toEqual([]);
    expect(typeof proposal.proposal_id).toBe('string');
    // The owner is not at the keyboard; the expiry is what the agent relays.
    // The proposal was made at the wake 2 read, ten minutes into the scenario.
    expect(proposal.expires_at).toBe(
      new Date(T0.getTime() + (10 + DEFAULT_PROPOSAL_TTL_MIN) * 60_000).toISOString(),
    );
  });

  it('wake 3: approving 30 minutes later executes and the board is ours again', () => {
    const approval = scenario.wake3Approval;
    expect(approval.status).toBe('executed');
    expect(approval.error).toBeUndefined();
    expect(approval.proposal_id).toBe(scenario.wake2Proposal.proposal_id);
    expect(approval.transactions_sent).toBe(1);
    expect(approval.billboard_after).toMatchObject({
      poster: scenario.wallet,
      amount_sol: OUR_BID,
      you_are_poster: true,
    });

    const executed = scenario.activity.filter((e) => e.event === 'executed');
    expect(executed).toHaveLength(1);
    expect(executed[0]!.tool).toBe(ACQUIRE_TOOL);
    expect(executed[0]!.proposal_id).toBe(approval.proposal_id);
    expect(executed[0]!.tx).toBe(approval.signatures[0]);
  });

  it('wake 4: the second draft supersedes the first, and the log names both ids', () => {
    expect(scenario.wake4FirstDraft.status).toBe('proposed');
    expect(scenario.wake4SecondDraft.status).toBe('proposed');
    expect(scenario.wake4SecondDraft.proposal_id).not.toBe(scenario.wake4FirstDraft.proposal_id);

    const superseded = scenario.activity.filter((e) => e.event === 'superseded');
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.tool).toBe(APPEND_TOOL);
    expect(superseded[0]!.proposal_id).toBe(scenario.wake4FirstDraft.proposal_id);
    expect(superseded[0]!.superseded_by).toBe(scenario.wake4SecondDraft.proposal_id);
    expect(superseded[0]!.reasoning).toBe(FIRST_DRAFT_REASONING);
  });

  it('wake 4: approving the superseded id refuses and points at the replacement', () => {
    const refusal = scenario.wake4StaleApproval;
    expect(refusal.status).toBe('refused');
    expect(refusal.error).toBe('superseded');
    expect(refusal.superseded_by).toBe(scenario.wake4SecondDraft.proposal_id);
    expect(refusal.transactions_sent).toBe(0);
    expect(refusal.signatures).toEqual([]);
  });

  it('wake 5: 61 minutes on, the open proposal has expired and cannot be approved', () => {
    const refusal = scenario.wake5Approval;
    expect(refusal.status).toBe('refused');
    expect(refusal.error).toBe('expired');
    expect(refusal.proposal_id).toBe(scenario.wake4SecondDraft.proposal_id);
    expect(refusal.transactions_sent).toBe(0);
    expect(refusal.signatures).toEqual([]);
    expect(refusal.reason).toContain('make a new one');

    const expired = scenario.activity.filter((e) => e.event === 'expired');
    expect(expired).toHaveLength(1);
    expect(expired[0]!.proposal_id).toBe(scenario.wake4SecondDraft.proposal_id);
  });

  it('the activity log tells the whole heartbeat in order, and nothing failed', () => {
    expect(scenario.activity.map((e) => e.event)).toEqual([
      'outbid_detected',
      'proposed',
      'approved',
      'executed',
      'proposed',
      'superseded',
      'proposed',
      'expired',
    ]);
    expect(scenario.activity.map((e) => e.event)).not.toContain('failed');
    // One transaction in the whole scenario: the approved bid.
    expect(scenario.activity.filter((e) => typeof e.tx === 'string')).toHaveLength(1);
    // Every line is stamped in order, so the next wake can read the log back.
    const stamps = scenario.activity.map((e) => Date.parse(e.ts));
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });
});
