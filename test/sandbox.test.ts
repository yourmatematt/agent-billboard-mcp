/**
 * The sandbox: which RPC a sandbox session gets, what it does not reach for,
 * what each scenario looks like on the first read (S2), and the whole
 * rehearsal walk an operator runs on day one (S6).
 *
 * The walk at the bottom is the promise the README makes in "Try it without
 * a wallet", asserted: `BILLBOARD_SANDBOX=true` and nothing else takes an
 * agent from read to dry run to propose to approve to acquire, shows it as
 * the poster, lets an outsider displace it, and pays the refund back — with
 * every result marked, every signature unmistakable, the real activity log
 * untouched and the spend ceiling enforced exactly as it is on mainnet.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRuntime } from '../src/cli.js';
import {
  DEFAULT_ACTIVITY_LOG_PATH,
  DEFAULT_SANDBOX_MAX_BID_SOL,
  loadConfig,
  type SandboxScenario,
} from '../src/config.js';
import type { ActivityEntry } from '../src/log/activity.js';
import { lamportsToSol, solToLamports } from '../src/program/math.js';
import { MOCK_SIGNATURE_RE, MockRpc } from '../src/rpc/MockRpc.js';
import { SolanaRpc } from '../src/rpc/SolanaRpc.js';
import {
  SANDBOX_ADVERSARIAL_MESSAGE,
  SANDBOX_CREATOR,
  SANDBOX_DEFAULT_MESSAGE,
  SANDBOX_HOLD_SECONDS,
  SANDBOX_PREVIOUS_POSTER,
  SANDBOX_START_UNIX,
  createSandboxRpc,
} from '../src/sandbox.js';
import { createServer } from '../src/server.js';
import { ACQUIRE_TOOL } from '../src/tools/acquire_posting_rights.js';
import { APPROVE_TOOL } from '../src/tools/approve_proposal.js';
import { getFlipHistory } from '../src/tools/get_flip_history.js';
import { READ_BILLBOARD_TOOL, readBillboard } from '../src/tools/read_billboard.js';

let dir: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-sandbox-'));
});
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function sandboxConfig(env: NodeJS.ProcessEnv = {}) {
  return loadConfig(
    { BILLBOARD_SANDBOX: 'true', INTENT_PATH: join(dir, 'intent.md'), ...env },
    { cwd: dir, dotenvPath: null },
  );
}

describe('createRuntime', () => {
  it('gives a sandbox session a MockRpc and never a SolanaRpc', async () => {
    const { rpc } = await createRuntime(sandboxConfig());
    expect(rpc).toBeInstanceOf(MockRpc);
    expect(rpc).not.toBeInstanceOf(SolanaRpc);
  });

  it('ignores RPC_URL entirely: the simulated board is the only source of state', async () => {
    const config = sandboxConfig({ RPC_URL: 'https://rpc.example.com/v1/KEY-abc' });
    const { rpc } = await createRuntime(config);
    expect(rpc).toBeInstanceOf(MockRpc);
    // The ignored URL never reaches the config either, so it cannot be dialled.
    expect(config.rpcUrl).not.toContain('rpc.example.com');
  });

  it('gives the real board a SolanaRpc', async () => {
    const config = loadConfig(
      { INTENT_PATH: join(dir, 'intent.md') },
      { cwd: dir, dotenvPath: null },
    );
    const { rpc } = await createRuntime(config);
    expect(rpc).toBeInstanceOf(SolanaRpc);
    expect(rpc).not.toBeInstanceOf(MockRpc);
  });
});

describe('a sandbox session makes no network call', () => {
  it('never reaches global fetch, even with HISTORY_URL set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const config = sandboxConfig({ HISTORY_URL: 'https://site.example.com/history.json' });
    expect(config.historyUrl).toBe('https://site.example.com/history.json');

    const warnings: string[] = [];
    const { rpc, context } = await createRuntime(config);
    const warned = { ...context, warn: (line: string) => warnings.push(line) };

    await readBillboard(warned);
    const history = await getFlipHistory(warned);

    expect(fetchSpy).not.toHaveBeenCalled();
    // The refusal is visible rather than silent, and history still derives.
    expect(warnings.join('\n')).toContain('BILLBOARD_SANDBOX is on');
    expect(history.source).toBe('on-chain');
    expect(history.flips.length).toBeGreaterThan(0);
    expect(rpc).toBeInstanceOf(MockRpc);
  });

  it('subscribes in process rather than over a websocket', async () => {
    const { rpc, context } = await createRuntime(sandboxConfig());
    expect(context.reader.subscribe()).toBe(true);
    // MockRpc notifies its listeners directly; there is no socket to open.
    expect(rpc).toBeInstanceOf(MockRpc);
    context.reader.unsubscribe();
  });
});

describe('scenario seeds', () => {
  async function read(scenario: SandboxScenario) {
    const config = sandboxConfig({ BILLBOARD_SANDBOX_SCENARIO: scenario });
    const { context } = await createRuntime(config);
    return readBillboard(context);
  }

  it('default: the previous poster holds at 0.1 SOL with an honest message', async () => {
    const output = await read('default');
    expect(output.poster).toBe(SANDBOX_PREVIOUS_POSTER.publicKey.toBase58());
    expect(output.amount_sol).toBe('0.1');
    expect(output.minimum_bid_sol).toBe('0.101');
    expect(output.message).toBe(SANDBOX_DEFAULT_MESSAGE);
    expect(output.message).toContain('npx agent-billboard-mcp');
    expect(output.you_are_poster).toBe(false);
  });

  it('adversarial: the same board, carrying the adversarial message', async () => {
    const output = await read('adversarial');
    expect(output.poster).toBe(SANDBOX_PREVIOUS_POSTER.publicKey.toBase58());
    expect(output.amount_sol).toBe('0.1');
    expect(output.message).toBe(SANDBOX_ADVERSARIAL_MESSAGE);
  });

  it('idle: nobody has posted and the board is at 0 SOL', async () => {
    const output = await read('idle');
    expect(output.amount_sol).toBe('0');
    expect(output.minimum_bid_sol).toBe('0');
    expect(output.message).toBe('');
    expect(output.message_bytes).toBe(0);
    expect(output.you_are_poster).toBe(false);
  });

  it('is deterministic: two runs of a scenario agree on keys, clock and history', async () => {
    const [a, b] = await Promise.all([createSandboxRpc('default'), createSandboxRpc('default')]);
    expect(a.billboard.poster.toBase58()).toBe(b.billboard.poster.toBase58());
    expect(a.billboard.creator.toBase58()).toBe(SANDBOX_CREATOR.publicKey.toBase58());
    expect(a.now()).toBe(b.now());
    expect(a.now()).toBe(SANDBOX_START_UNIX);
    expect(a.currentSlot()).toBe(b.currentSlot());
    expect(a.transactions.map((t) => t.signature)).toEqual(b.transactions.map((t) => t.signature));
  });

  it('idle starts at the same clock as the seeded scenarios', async () => {
    const rpc = await createSandboxRpc('idle');
    expect(rpc.now()).toBe(SANDBOX_START_UNIX);
    expect(rpc.transactions).toHaveLength(0);
  });

  it('the previous poster has held for an hour when the agent first looks', async () => {
    const config = sandboxConfig();
    const { context } = await createRuntime(config);
    const history = await getFlipHistory(context);
    const newest = history.flips[0]!;
    expect(newest.poster).toBe(SANDBOX_PREVIOUS_POSTER.publicKey.toBase58());
    expect(newest.amount_sol).toBe('0.1');
    expect(SANDBOX_HOLD_SECONDS).toBe(3600);
  });
});

// ---------------------------------------------------------------------------
// The rehearsal walk (S6)
// ---------------------------------------------------------------------------

/** What the agent posts once it holds the simulated board. */
const REHEARSAL_MESSAGE =
  'Tall Poppy Bakes, Newcastle NSW. Sourdough and a very good fruit loaf. ' +
  'Read the board and post yourself: npx agent-billboard-mcp';

/** What the simulated outsider pays to displace the agent. */
const OUTSIDE_BID_SOL = '0.2';
/** What the outsider posts, so the displacement is visible in the next read. */
const OUTSIDE_MESSAGE = 'ours now. 0.2 SOL.';
/** Over the sandbox `MAX_BID_SOL` default of 1, so the ceiling is what refuses it. */
const OVER_LIMIT_BID_SOL = '1.5';

const WHY =
  'Rehearsal in sandbox before the first real bid: nothing here is signed against mainnet.';

interface Call {
  step: string;
  isError: boolean;
  text: string;
  structured: Record<string, unknown>;
}

interface Walk {
  calls: Call[];
  activity: ActivityEntry[];
  rpc: MockRpc;
  wallet: string;
  logPath: string;
  realLogPath: string;
}

/**
 * Read -> dry run -> propose -> approve -> read -> outside acquire -> read ->
 * over-limit bid, through the in-memory transport, on a sandbox session
 * started the way the README says to start one.
 */
async function rehearse(): Promise<Walk> {
  const config = loadConfig(
    { BILLBOARD_SANDBOX: 'true', INTENT_PATH: join(dir, 'intent.md') },
    { cwd: dir, dotenvPath: null },
  );
  const { rpc, context } = await createRuntime(config);
  // Sandbox always means MockRpc (asserted above); the walk needs the mock's
  // own handles to stand in for a rival wallet.
  expect(rpc).toBeInstanceOf(MockRpc);
  const mock = rpc as MockRpc;
  // The CLI subscribes in every write mode; without it an outside acquire is
  // only noticed on the next read rather than as it happens.
  expect(context.reader.subscribe()).toBe(true);

  const server = createServer(context);
  const client = new Client({ name: 'sandbox-rehearsal', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    context.reader.unsubscribe();
    await client.close();
    await server.close();
  });

  const calls: Call[] = [];
  const call = async (step: string, tool: string, args: Record<string, unknown>): Promise<Call> => {
    const result = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
    const first = result.content[0];
    const made: Call = {
      step,
      isError: result.isError === true,
      text: first !== undefined && first.type === 'text' ? first.text : '',
      structured: (result.structuredContent ?? {}) as Record<string, unknown>,
    };
    calls.push(made);
    return made;
  };

  await call('read', READ_BILLBOARD_TOOL, {});
  await call('dry run', ACQUIRE_TOOL, { dry_run: true, reasoning: WHY });
  const proposed = await call('propose', ACQUIRE_TOOL, {
    message: REHEARSAL_MESSAGE,
    reasoning: WHY,
  });
  await call('approve', APPROVE_TOOL, { proposal_id: proposed.structured['proposal_id'] });
  await call('read as poster', READ_BILLBOARD_TOOL, {});

  // Not a tool call: the mock standing in for another wallet on mainnet.
  mock.advanceClock(SANDBOX_HOLD_SECONDS);
  await mock.acquireAs(Keypair.generate(), solToLamports(OUTSIDE_BID_SOL), OUTSIDE_MESSAGE);

  await call('read after outbid', READ_BILLBOARD_TOOL, {});
  await call('over-limit bid', ACQUIRE_TOOL, { bid_sol: OVER_LIMIT_BID_SOL, reasoning: WHY });

  return {
    calls,
    activity: context.activityLog.entries(),
    rpc: mock,
    wallet: config.keypair!.publicKey.toBase58(),
    logPath: config.activityLogPath,
    realLogPath: join(dir, DEFAULT_ACTIVITY_LOG_PATH),
  };
}

describe('the rehearsal walk, with no configuration but BILLBOARD_SANDBOX', () => {
  let walk: Walk;

  beforeEach(async () => {
    walk = await rehearse();
  });

  it('starts on the default board: someone holding at 0.1 SOL, and it is not us', () => {
    const read = walk.calls[0]!.structured;
    expect(walk.calls[0]!.isError).toBe(false);
    expect(read['poster']).toBe(SANDBOX_PREVIOUS_POSTER.publicKey.toBase58());
    expect(read['amount_sol']).toBe('0.1');
    expect(read['minimum_bid_sol']).toBe('0.101');
    expect(read['you_are_poster']).toBe(false);
    const operator = read['operator'] as { limits: Record<string, unknown> };
    expect(operator.limits).toMatchObject({
      max_bid_sol: DEFAULT_SANDBOX_MAX_BID_SOL,
      daily_cap_sol: DEFAULT_SANDBOX_MAX_BID_SOL,
      spent_last_24h_sol: '0',
      auto_bid: false,
      read_only: false,
    });
  });

  it('prices the bid in the dry run and signs nothing', () => {
    const dry = walk.calls[1]!.structured;
    expect(dry['status']).toBe('dry_run');
    expect(dry['bid_sol']).toBe('0.101');
    expect(dry['previous_holder_receives_sol']).toBe('0.1005');
    expect(dry['creator_receives_sol']).toBe('0.0005');
    expect(dry['transactions_sent']).toBe(0);
    expect(dry['signatures']).toEqual([]);
  });

  it('returns a proposal rather than a transaction, because AUTO_BID defaults to false', () => {
    const proposed = walk.calls[2]!.structured;
    expect(proposed['status']).toBe('proposed');
    expect(typeof proposed['proposal_id']).toBe('string');
    expect(proposed['transactions_sent']).toBe(0);
    expect(typeof proposed['expires_at']).toBe('string');
  });

  it('approve_proposal is what acquires the board, in one simulated transaction', () => {
    const approved = walk.calls[3]!.structured;
    expect(walk.calls[3]!.isError).toBe(false);
    expect(approved['status']).toBe('executed');
    expect(approved['transactions_planned']).toBe(1);
    expect(approved['transactions_sent']).toBe(1);
    expect((approved['signatures'] as string[])[0]).toMatch(MOCK_SIGNATURE_RE);
  });

  it('the next read shows the agent as poster with its own message up', () => {
    const read = walk.calls[4]!.structured;
    expect(read['poster']).toBe(walk.wallet);
    expect(read['you_are_poster']).toBe(true);
    expect(read['amount_sol']).toBe('0.101');
    expect(read['message']).toBe(REHEARSAL_MESSAGE);
  });

  it('an outside acquire displaces the agent and the read says so', () => {
    const read = walk.calls[5]!.structured;
    expect(read['you_are_poster']).toBe(false);
    expect(read['poster']).not.toBe(walk.wallet);
    expect(read['amount_sol']).toBe(OUTSIDE_BID_SOL);
    expect(read['message']).toBe(OUTSIDE_MESSAGE);
    expect(read['changed_since_last_read']).toBe(true);
  });

  it('logs outbid_detected when the displacement happens, not when the agent next looks', () => {
    const events = walk.activity.map((e) => e.event);
    expect(events).toEqual([
      'proposed',
      'approved',
      'executed',
      'outbid_detected',
      'refused_limit',
    ]);
    const outbid = walk.activity.find((e) => e.event === 'outbid_detected')!;
    expect(outbid.tool).toBe('billboard_reader');
    expect((outbid.billboard_before as { poster: string }).poster).toBe(walk.wallet);
    expect((outbid.billboard_after as { poster: string }).poster).not.toBe(walk.wallet);
  });

  it('pays the refund back to the agent: 0.101 plus half the difference', () => {
    const refunds = walk.rpc.transfers.filter((t) => t.to.toBase58() === walk.wallet);
    expect(refunds).toHaveLength(1);
    // Current 0.101, bid 0.2: the creator takes 50% of the 0.099 difference and
    // the displaced holder gets the rest back, which is more than it paid.
    expect(lamportsToSol(refunds[0]!.lamports)).toBe('0.1505');
    expect(refunds[0]!.lamports).toBeGreaterThan(solToLamports('0.101'));
    const toCreator = walk.rpc.transfers.filter(
      (t) => t.to.toBase58() === SANDBOX_CREATOR.publicKey.toBase58(),
    );
    expect(lamportsToSol(toCreator.at(-1)!.lamports)).toBe('0.0495');
  });

  it('refuses a bid over the defaulted MAX_BID_SOL, exactly as it would on mainnet', () => {
    const refused = walk.calls[6]!;
    expect(refused.isError).toBe(true);
    expect(refused.structured['status']).toBe('refused');
    expect(refused.structured['error']).toBe('limit_exceeded');
    expect(refused.structured['transactions_sent']).toBe(0);
    expect(refused.structured['signatures']).toEqual([]);
    expect(refused.structured['limits']).toMatchObject({
      ok: false,
      reason: 'max_bid',
      max_bid_sol: DEFAULT_SANDBOX_MAX_BID_SOL,
      spent_last_24h_sol: '0.101',
    });
    const logged = walk.activity.at(-1)!;
    expect(logged.event).toBe('refused_limit');
    expect(logged.bid_sol).toBe(OVER_LIMIT_BID_SOL);
    expect(logged.tx).toBeUndefined();
  });

  it('marks every structured result as sandbox', () => {
    for (const { step, structured } of walk.calls) {
      expect(structured['sandbox'], step).toBe(true);
    }
  });

  it('never produces a signature that could be pasted into an explorer', () => {
    const signatures = [
      ...walk.calls.flatMap((c) => (c.structured['signatures'] ?? []) as string[]),
      ...walk.rpc.transactions.map((t) => t.signature),
      ...walk.rpc.transfers.map((t) => t.signature),
      ...walk.activity.flatMap((e) => (typeof e.tx === 'string' ? [e.tx] : [])),
    ];
    expect(signatures.length).toBeGreaterThan(0);
    for (const signature of signatures) expect(signature).toMatch(MOCK_SIGNATURE_RE);
  });

  it('writes to the sandbox log and leaves the real activity log alone', () => {
    expect(walk.logPath).toBe(join(dir, 'billboard-sandbox-activity.jsonl'));
    expect(existsSync(walk.logPath)).toBe(true);
    expect(existsSync(walk.realLogPath)).toBe(false);

    const lines = readFileSync(walk.logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(walk.activity.length);
    for (const line of lines) {
      const entry = JSON.parse(line) as ActivityEntry;
      expect(typeof entry.event).toBe('string');
      if (typeof entry.tx === 'string') expect(entry.tx).toMatch(MOCK_SIGNATURE_RE);
    }
  });
});
