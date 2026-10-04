/**
 * src/agent/run.ts: `run` end to end in temp folders, on a fake clock,
 * against MockRpc, through the fake claude. No network and no model: every
 * wake here runs test/fixtures/fake-claude.mjs. Key material is generated in
 * the temp folder by `init`, never funded, and removed after each test.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InitArgs, RunArgs } from '../../src/cli.js';
import { agentPaths, writeEnvFile, type AgentPaths } from '../../src/agent/folder.js';
import { runInit } from '../../src/agent/init.js';
import {
  PROPOSE_MODE_REFUSAL,
  clockTime,
  consoleLine,
  runRun,
  shortKey,
  type ConsoleContext,
  type RunDeps,
} from '../../src/agent/run.js';
import {
  hashData,
  pricedOutMessage,
  type RunnerLogEntry,
  type RunnerState,
} from '../../src/agent/runner.js';
import { MCP_SERVER_KEY, ALLOWED_TOOLS } from '../../src/agent/settings.js';
import type { WakeLogEntry } from '../../src/agent/wake.js';
import { loadKeypair } from '../../src/config.js';
import { BILLBOARD_ADDRESS } from '../../src/program/layout.js';
import { minimumBid } from '../../src/program/math.js';
import { MockRpc } from '../../src/rpc/MockRpc.js';
import { installFakeClaude, type FakeClaude } from './fake-claude.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.parse('2026-10-04T00:00:00.000Z');
const SOL = 1_000_000_000n;

let root: string;
let paths: AgentPaths;
let fake: FakeClaude;
// In memory only, never funded.
let outsider: Keypair;
let rival: Keypair;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abm-run-'));
  paths = agentPaths('agent', root);
  fake = installFakeClaude(root);
  outsider = Keypair.generate();
  rival = Keypair.generate();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A real agent folder, written by `init` (no rehearsal, board offline). */
async function initAgent(
  mode: 'auto' | 'propose' = 'auto',
  extra: Partial<InitArgs> = {},
): Promise<{ wallet: Keypair; key: string }> {
  const code = await runInit(
    {
      dir: 'agent',
      belief: 'Small tools that do one thing well outlast clever ones.',
      maxBid: '0.5',
      dailyCap: '1',
      mode,
      newWallet: true,
      keypair: null,
      model: null,
      yes: true,
      force: false,
      skipRehearsal: true,
      ...extra,
    },
    {
      cwd: root,
      io: { interactive: false, write: () => {}, writeErr: () => {} },
      rpc: { getAccount: async () => null },
    },
  );
  expect(code).toBe(0);
  const wallet = loadKeypair(paths.keypair);
  return { wallet, key: wallet.publicKey.toBase58() };
}

const runArgs = (over: Partial<RunArgs> = {}): RunArgs => ({
  dir: 'agent',
  sandbox: false,
  once: false,
  dryRun: false,
  claude: fake.command.path,
  model: null,
  minutes: null,
  ...over,
});

interface Harness {
  clock: { t: number };
  out: string[];
  err: string[];
  rpcCalls: string[];
  /** Runs `fn` when the fake clock reaches `at`. */
  at: (at: number, fn: () => unknown) => void;
  deps: RunDeps;
}

function harness(
  mock: MockRpc | null,
  options: { mode?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Harness {
  const clock = { t: START };
  const out: string[] = [];
  const err: string[] = [];
  const rpcCalls: string[] = [];
  const events: { at: number; fn: () => unknown; done?: boolean }[] = [];
  const rpc = {
    getAccount: async (key: PublicKey) => {
      rpcCalls.push('getAccount');
      if (!mock) throw new Error('no RPC in this test');
      return mock.getAccount(key);
    },
    getBalance: async (key: PublicKey) => {
      rpcCalls.push('getBalance');
      if (!mock) throw new Error('no RPC in this test');
      return mock.getBalance(key);
    },
  };
  return {
    clock,
    out,
    err,
    rpcCalls,
    at: (at, fn) => events.push({ at, fn }),
    deps: {
      cwd: root,
      env: { ...process.env, ...options.env, FAKE_CLAUDE_MODE: options.mode ?? 'succeed' },
      io: { write: (t) => out.push(t), writeErr: (t) => err.push(t) },
      rpc,
      now: () => clock.t,
      random: () => 0.5,
      sleep: async (ms) => {
        const target = clock.t + ms;
        const ev = events.filter((e) => !e.done && e.at <= target).sort((a, b) => a.at - b.at)[0];
        if (ev) {
          clock.t = Math.max(clock.t, ev.at);
          ev.done = true;
          await ev.fn();
        } else clock.t = target;
      },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  };
}

const lines = (chunks: string[]): string[] => chunks.join('').split('\n').filter(Boolean);
const jsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];
const runnerEvents = (name: string) =>
  jsonl<RunnerLogEntry>(paths.runnerLog).filter((e) => e.event === name);
const wakeLog = () => jsonl<WakeLogEntry>(paths.wakeLog);
const argAfter = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

/** A state file that says the agent woke an hour ago and looks again in 20 h. */
async function seedState(mock: MockRpc): Promise<void> {
  const data = await mock.getAccount(BILLBOARD_ADDRESS);
  const state: RunnerState = {
    version: 1,
    last_board_hash: hashData(data as Buffer),
    last_poster: mock.billboard.poster.toBase58(),
    last_amount: mock.billboard.amount.toString(),
    pending_reaction_at: null,
    next_look_at: new Date(START + 20 * HOUR).toISOString(),
    first_wake_at: null,
    last_wake_at: new Date(START - HOUR).toISOString(),
    wakes: [{ ts: new Date(START - HOUR).toISOString(), trigger: 'first' }],
  };
  writeFileSync(paths.runnerState, `${JSON.stringify(state, null, 2)}\n`);
}

describe('run: a board that changes under a fake clock', () => {
  it('own post ignored, one affordable change wakes once, a priced-out change does not', async () => {
    const { wallet, key } = await initAgent();
    const mock = new MockRpc({ poster: outsider.publicKey, amount: SOL / 10n });
    mock.setBalance(wallet.publicKey, SOL);
    await seedState(mock);
    const h = harness(mock);
    // +30 min: this agent posts (by hand, say). Its own post is no reason to wake.
    h.at(START + 30 * MIN, () => mock.acquireAs(wallet, 150_000_000n, 'mine'));
    // +60 min: a rival outbids at 0.2 SOL. Minimum 0.202 <= 0.5: one wake.
    h.at(START + 60 * MIN, () => mock.acquireAs(rival, 200_000_000n, 'theirs'));
    // +3 h: a rival outbids at 0.6 SOL. Minimum 0.606 > 0.5: priced out, no wake.
    h.at(START + 3 * HOUR, () => mock.acquireAs(rival, 600_000_000n, 'dearer'));

    const code = await runRun(runArgs({ minutes: 5 * 60 }), h.deps);
    expect(code).toBe(0);

    // Exactly one wake reached claude, and it was the board change.
    const calls = fake.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(paths.dir);
    expect(argAfter(calls[0]!.argv, '--mcp-config')).toBe(paths.mcpJson);
    expect(argAfter(calls[0]!.argv, '--allowedTools')).toBe(ALLOWED_TOOLS.join(','));
    expect(calls[0]?.stdin).toContain('The billboard changed since you last looked.');
    const wakes = wakeLog();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      trigger: 'board_changed',
      sandbox: false,
      decision: 'passed',
    });

    expect(runnerEvents('own_post_ignored')).toHaveLength(1);
    expect(runnerEvents('wake_started')).toHaveLength(1);
    const priced = runnerEvents('priced_out');
    expect(priced).toHaveLength(1);
    expect(Date.parse(String(priced[0]?.ts))).toBeGreaterThanOrEqual(START + 3 * HOUR);
    expect(runnerEvents('stopped')[0]?.reason).toBe('minutes elapsed');

    const out = lines(h.out);
    expect(out[0]).toContain('run');
    expect(out).toContain(`  wallet   ${key}`);
    expect(out).toContain('  model    Claude Code default');
    expect(out).toContain('Every wake is a model call on your own Claude Code login and usage.');
    expect(out).toContain('Ctrl+C to stop.');
    const events = out.filter((l) => /^\d\d:\d\d {2}/.test(l)).map((l) => l.slice(7));
    expect(events).toContain("That is this agent's own post, so it is no reason to wake.");
    expect(events).toContain('Waking Claude Code (the board changed).');
    expect(
      events.filter((l) =>
        l.startsWith(
          'passed - The minimum bid is more than this belief is worth today. Next look around ',
        ),
      ),
    ).toHaveLength(1);
    expect(events.filter((l) => l.startsWith('Priced out:'))).toEqual([
      pricedOutMessage(minimumBid(600_000_000n), SOL / 2n),
    ]);
    expect(events[events.length - 1]).toBe('Stopped: the --minutes given are up. State saved.');
    expect(h.err).toEqual([]);

    // The keypair file's contents never reach the console.
    const secret = readFileSync(paths.keypair, 'utf8').trim();
    expect(h.out.join('')).not.toContain(secret);
  });

  it('priced out from the start: zero wakes and exactly one console line about it', async () => {
    const { wallet } = await initAgent();
    const mock = new MockRpc({ poster: outsider.publicKey, amount: SOL });
    mock.setBalance(wallet.publicKey, 5n * SOL);
    const h = harness(mock);
    const code = await runRun(runArgs({ minutes: 6 * 60 }), h.deps);
    expect(code).toBe(0);
    expect(fake.calls()).toHaveLength(0);
    expect(existsSync(paths.wakeLog)).toBe(false);
    // Polled every 1-3 min for six hours, logged once.
    expect(h.rpcCalls.filter((c) => c === 'getAccount').length).toBeGreaterThan(100);
    expect(h.rpcCalls).not.toContain('getBalance');
    expect(runnerEvents('priced_out')).toHaveLength(1);
    const priced = lines(h.out).filter((l) => l.includes('Priced out'));
    expect(priced).toHaveLength(1);
    // Gated when the first look fell due: random 0.5 x first_wake_max_min 5 = 2.5 min in.
    expect(priced[0]).toBe(
      `${clockTime(START + 2.5 * MIN)}  ${pricedOutMessage(minimumBid(SOL), SOL / 2n)}`,
    );
  });

  it('the model comes from --model, else agent.json, else none', async () => {
    const { wallet } = await initAgent('auto', { model: 'claude-from-agent-json' });
    const mock = new MockRpc({ poster: outsider.publicKey, amount: SOL / 10n });
    mock.setBalance(wallet.publicKey, SOL);
    let h = harness(mock);
    expect(await runRun(runArgs({ once: true }), h.deps)).toBe(0);
    expect(lines(h.out)).toContain('  model    claude-from-agent-json');
    h = harness(mock);
    h.clock.t = START + 2 * HOUR;
    expect(await runRun(runArgs({ once: true, model: 'claude-from-flag' }), h.deps)).toBe(0);
    const calls = fake.calls();
    expect(calls).toHaveLength(2);
    expect(argAfter(calls[0]!.argv, '--model')).toBe('claude-from-agent-json');
    expect(argAfter(calls[1]!.argv, '--model')).toBe('claude-from-flag');
  });
});

describe('run --once', () => {
  it('one manual wake through the gate, recorded in the live state, then exit 0', async () => {
    const { wallet } = await initAgent();
    const mock = new MockRpc({ poster: outsider.publicKey, amount: SOL / 10n });
    mock.setBalance(wallet.publicKey, SOL);
    const h = harness(mock);
    const code = await runRun(runArgs({ once: true }), h.deps);
    expect(code).toBe(0);
    expect(fake.calls()).toHaveLength(1);
    expect(fake.calls()[0]?.stdin).toContain('Your operator started a one-off wake.');
    expect(wakeLog()[0]).toMatchObject({ trigger: 'manual', sandbox: false });
    const state = JSON.parse(readFileSync(paths.runnerState, 'utf8')) as RunnerState;
    expect(state.wakes).toEqual([{ ts: new Date(START).toISOString(), trigger: 'manual' }]);
    expect(h.rpcCalls).toEqual(['getAccount', 'getBalance']);
    const out = lines(h.out);
    expect(out.some((l) => l.endsWith('It asked to look again in 6 h.'))).toBe(true);
    expect(out[out.length - 1]).toBe(
      'Done. The wake is in logs/wake.log; see the record with: agent-billboard-mcp report',
    );
    expect(runnerEvents('stopped')[0]?.reason).toBe('once');
  });

  it('the gate holds it back when this agent is the poster: no wake, exit 0', async () => {
    const { wallet } = await initAgent();
    const mock = new MockRpc({ poster: outsider.publicKey, amount: SOL / 10n });
    await mock.acquireAs(wallet, 150_000_000n, 'mine');
    mock.setBalance(wallet.publicKey, SOL);
    const h = harness(mock);
    expect(await runRun(runArgs({ once: true }), h.deps)).toBe(0);
    expect(fake.calls()).toHaveLength(0);
    const out = lines(h.out);
    expect(out).toContain(`${clockTime(START)}  No wake: this agent is the poster right now.`);
    expect(out[out.length - 1]).toBe(
      'No wake: the agent cannot act right now (the line above says why).',
    );
  });

  it('an unfunded wallet is told how much to send, and where', async () => {
    const { wallet, key } = await initAgent();
    const mock = new MockRpc({ poster: outsider.publicKey, amount: SOL / 10n });
    mock.setBalance(wallet.publicKey, 50_000_000n);
    const h = harness(mock);
    expect(await runRun(runArgs({ once: true }), h.deps)).toBe(0);
    expect(fake.calls()).toHaveLength(0);
    // min 0.101 + 0.01 = 0.111 needed; 0.05 held; 0.061 short.
    expect(lines(h.out)).toContain(
      `${clockTime(START)}  No wake: the wallet holds 0.05 SOL and needs 0.111 SOL (the minimum bid plus 0.01 SOL for fees). Send at least 0.061 SOL to ${key}.`,
    );
  });

  it('a PAUSE file stops a one-off wake too', async () => {
    await initAgent();
    writeFileSync(paths.pause, '');
    const h = harness(new MockRpc());
    expect(await runRun(runArgs({ once: true }), h.deps)).toBe(0);
    expect(fake.calls()).toHaveLength(0);
    expect(h.rpcCalls).toEqual([]);
    expect(lines(h.out)).toContain('No wake: there is a PAUSE file in the folder.');
  });

  it('an unreadable board is exit 1 and no wake', async () => {
    await initAgent();
    const h = harness(null);
    expect(await runRun(runArgs({ once: true }), h.deps)).toBe(1);
    expect(fake.calls()).toHaveLength(0);
    const out = lines(h.out);
    expect(out.some((l) => l.includes('Could not read the board (no RPC in this test)'))).toBe(
      true,
    );
    expect(out[out.length - 1]).toBe('No wake: the board could not be read.');
  });

  it('a wake that exits non-zero is exit 1, pointing at its transcript', async () => {
    const { wallet } = await initAgent();
    const mock = new MockRpc({ poster: outsider.publicKey, amount: SOL / 10n });
    mock.setBalance(wallet.publicKey, SOL);
    const h = harness(mock, { mode: 'fail' });
    expect(await runRun(runArgs({ once: true }), h.deps)).toBe(1);
    const entry = wakeLog()[0];
    expect(entry?.exit_code).toBe(3);
    const out = lines(h.out);
    expect(out.some((l) => l.endsWith('(Claude Code exited with code 3.)'))).toBe(true);
    expect(out[out.length - 1]).toBe(
      `The wake did not finish cleanly. Its transcript is ${entry?.transcript}.`,
    );
  });

  it('Ctrl+C during a wake kills it, logs it stopped and saves state', async () => {
    const { wallet } = await initAgent();
    const mock = new MockRpc({ poster: outsider.publicKey, amount: SOL / 10n });
    mock.setBalance(wallet.publicKey, SOL);
    const controller = new AbortController();
    const h = harness(mock, { mode: 'hang', signal: controller.signal });
    const watcher = setInterval(() => {
      if (fake.calls().length > 0) controller.abort();
    }, 50);
    let code: number;
    try {
      code = await runRun(runArgs({ once: true }), h.deps);
    } finally {
      clearInterval(watcher);
    }
    expect(code).toBe(0);
    const entry = wakeLog()[0];
    expect(entry).toMatchObject({ stopped: true, timed_out: false });
    const pid = fake.calls()[0]!.pid;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(runnerEvents('stopped')[0]?.reason).toBe('signal');
    expect(existsSync(paths.runnerState)).toBe(true);
    const out = lines(h.out);
    expect(out.some((l) => l.endsWith('(Stopped by Ctrl+C.)'))).toBe(true);
    expect(out[out.length - 1]).toBe('Stopped by Ctrl+C. The wake was ended and logged.');
  }, 30_000);
});

describe('run --sandbox', () => {
  it('writes .mcp.sandbox.json beside .mcp.json, passes it, and reads no board (propose mode too)', async () => {
    await initAgent('propose');
    const h = harness(null);
    const code = await runRun(runArgs({ sandbox: true, once: true }), h.deps);
    expect(code).toBe(0);
    expect(h.rpcCalls).toEqual([]);

    const live = JSON.parse(readFileSync(paths.mcpJson, 'utf8'));
    const twin = JSON.parse(readFileSync(paths.mcpSandboxJson, 'utf8'));
    expect(twin).toEqual({
      mcpServers: {
        [MCP_SERVER_KEY]: {
          ...live.mcpServers[MCP_SERVER_KEY],
          env: { BILLBOARD_SANDBOX: 'true' },
        },
      },
    });

    const calls = fake.calls();
    expect(calls).toHaveLength(1);
    expect(argAfter(calls[0]!.argv, '--mcp-config')).toBe(paths.mcpSandboxJson);
    expect(calls[0]?.stdin).toContain('Your operator started a one-off wake.');
    const entry = wakeLog()[0];
    expect(entry).toMatchObject({ trigger: 'manual', sandbox: true, decision: 'passed' });
    expect(entry?.transcript).toMatch(/^logs\/wakes\/\d{8}T\d{9}Z-sandbox\.jsonl$/);
    // Sandbox state lives under logs/, never in the live runner-state.json.
    expect(existsSync(join(paths.logs, 'runner-state.sandbox.json'))).toBe(true);
    expect(existsSync(paths.runnerState)).toBe(false);

    const out = lines(h.out);
    expect(out).toContain(
      '  wallet   a simulated one inside the sandbox server (your wallet is not used)',
    );
    expect(out.some((l) => l.startsWith('  mode     sandbox (propose):'))).toBe(true);
    expect(out[out.length - 1]).toBe(
      'Done. The wake is in logs/wake.log; see the record with: agent-billboard-mcp report --sandbox',
    );
  });

  it('keeps an operator-edited .mcp.json entry and its env, adding only the sandbox switch', async () => {
    await initAgent();
    writeFileSync(
      paths.mcpJson,
      JSON.stringify({
        mcpServers: {
          [MCP_SERVER_KEY]: { command: 'node', args: ['/x/cli.js'], env: { RPC_URL: 'http://x' } },
          other: { command: 'other', args: [] },
        },
      }),
    );
    const h = harness(null);
    expect(await runRun(runArgs({ sandbox: true, once: true }), h.deps)).toBe(0);
    expect(JSON.parse(readFileSync(paths.mcpSandboxJson, 'utf8'))).toEqual({
      mcpServers: {
        [MCP_SERVER_KEY]: {
          command: 'node',
          args: ['/x/cli.js'],
          env: { RPC_URL: 'http://x', BILLBOARD_SANDBOX: 'true' },
        },
      },
    });
  });
});

describe('run --dry-run', () => {
  it('reads and gates but never starts claude, and keeps its state apart', async () => {
    const { wallet } = await initAgent();
    const mock = new MockRpc({ poster: outsider.publicKey, amount: SOL / 10n });
    mock.setBalance(wallet.publicKey, SOL);
    const h = harness(mock);
    // A claude that does not exist is fine: a dry run never looks for it.
    const code = await runRun(
      runArgs({ dryRun: true, minutes: 30, claude: join(root, 'nowhere', 'claude') }),
      h.deps,
    );
    expect(code).toBe(0);
    expect(fake.calls()).toHaveLength(0);
    expect(runnerEvents('would_wake')).toHaveLength(1);
    expect(existsSync(join(paths.logs, 'runner-state.dry.json'))).toBe(true);
    expect(existsSync(paths.runnerState)).toBe(false);
    const out = lines(h.out);
    expect(out).toContain('  claude   not started in a dry run');
    expect(out).not.toContain(
      'Every wake is a model call on your own Claude Code login and usage.',
    );
    expect(
      out.some((l) =>
        l.endsWith('Dry run: Claude Code would wake now (its first look). Nothing was started.'),
      ),
    ).toBe(true);
  });
});

describe('run refusals', () => {
  const refused = async (args: RunArgs, h: Harness, sentence: string): Promise<void> => {
    expect(await runRun(args, h.deps)).toBe(2);
    const err = h.err.join('');
    expect(err).toContain(`agent-billboard-mcp: run: ${sentence}`);
    expect(err).toContain("Run 'agent-billboard-mcp run --help' for usage.");
    expect(h.out).toEqual([]);
    expect(fake.calls()).toHaveLength(0);
    expect(existsSync(paths.logs)).toBe(false);
  };

  it('propose mode refuses with the locked sentence', async () => {
    await initAgent('propose');
    await refused(runArgs(), harness(new MockRpc()), PROPOSE_MODE_REFUSAL);
  });

  it('a dry run of a propose-mode agent refuses too', async () => {
    await initAgent('propose');
    await refused(runArgs({ dryRun: true }), harness(new MockRpc()), PROPOSE_MODE_REFUSAL);
  });

  it('no folder, or no .env', async () => {
    await refused(runArgs(), harness(null), `There is no folder at ${paths.dir}.`);
    await initAgent();
    rmSync(paths.env);
    await refused(runArgs(), harness(null), `There is no .env in ${paths.dir}.`);
  });

  it('no keypair, an unusable keypair, no MAX_BID_SOL', async () => {
    await initAgent();
    const env = readFileSync(paths.env, 'utf8');
    writeFileSync(paths.env, env.replace(/^BILLBOARD_KEYPAIR=.*$/m, ''));
    await refused(
      runArgs(),
      harness(null),
      'There is no BILLBOARD_KEYPAIR in .env, so this agent has no wallet to act with.',
    );
    writeFileSync(paths.env, env);
    writeEnvFile(paths.env, { BILLBOARD_KEYPAIR: './missing.keypair.json' });
    await refused(runArgs(), harness(null), 'BILLBOARD_KEYPAIR in .env cannot be used:');
    writeFileSync(paths.env, env.replace(/^MAX_BID_SOL=.*$/m, ''));
    await refused(
      runArgs(),
      harness(null),
      'There is no MAX_BID_SOL in .env, so this agent has no per-bid limit; set one in SOL.',
    );
    writeFileSync(paths.env, env.replace(/^MAX_BID_SOL=.*$/m, 'MAX_BID_SOL=lots'));
    await refused(runArgs(), harness(null), 'MAX_BID_SOL in .env is not a SOL amount like 0.2.');
  });

  it('claude not found, at --claude or on PATH', async () => {
    await initAgent();
    const missing = join(root, 'nowhere', 'claude');
    await refused(
      runArgs({ claude: missing }),
      harness(null),
      `Claude Code was not found at ${missing}; install it, or point --claude at the claude executable.`,
    );
    const h = harness(null, { env: { PATH: join(root, 'empty'), Path: '', CLAUDE_PATH: '' } });
    await refused(runArgs({ claude: null }), h, 'Claude Code was not found on PATH');
  });

  it('a broken agent.json or a missing .mcp.json', async () => {
    await initAgent();
    writeFileSync(paths.agentJson, JSON.stringify({ react_min_mins: 5 }));
    await refused(
      runArgs(),
      harness(null),
      `invalid ${paths.agentJson}:
  - unknown setting: react_min_mins`,
    );
    rmSync(paths.agentJson);
    rmSync(paths.mcpJson);
    await refused(runArgs(), harness(null), `There is no .mcp.json in ${paths.dir};`);
    await refused(
      runArgs({ sandbox: true, once: true }),
      harness(null),
      `There is no .mcp.json in ${paths.dir};`,
    );
  });
});

describe('consoleLine', () => {
  const ctx: ConsoleContext = { wallet: 'W'.repeat(44), mode: 'live', once: false };
  const t = '2026-10-04T05:07:00.000Z';
  const line = (
    event: string,
    fields: Record<string, unknown> = {},
    c: Partial<ConsoleContext> = {},
  ) => consoleLine({ ts: t, event, ...fields }, { ...ctx, ...c });

  it('says something plain for every event an operator needs, and nothing for the rest', () => {
    expect(line('started', { first_wake_at: t })).toBe(`First look around ${clockTime(t)}.`);
    expect(line('started', { first_wake_at: t }, { once: true })).toBeNull();
    expect(line('change_seen', { poster: 'P'.repeat(44), amount_sol: '0.2' })).toBe(
      `The board changed: 0.2 SOL, posted by ${shortKey('P'.repeat(44))}.`,
    );
    expect(line('board_recorded', { poster: ctx.wallet, amount_sol: '0.2' })).toBe(
      'Board: 0.2 SOL, posted by this agent.',
    );
    expect(line('reaction_scheduled', { at: t })).toBe(
      `Wake scheduled for ${clockTime(t)} (the board changed).`,
    );
    expect(line('deferred', { until: t, reason: 'min_gap' })).toBe(
      `Wake held until ${clockTime(t)} by the gap between wakes (min_gap_min in agent.json).`,
    );
    expect(line('paused')).toBe(
      'Paused: there is a PAUSE file in the folder. No wakes until it is removed.',
    );
    expect(line('resumed')).toBe('Resumed: the PAUSE file is gone.');
    expect(line('poll_error', { error: '503', retry_in_s: 30 })).toBe(
      'Could not read the board (503). Trying again in 30 s.',
    );
    expect(line('priced_out', { message: 'Priced out: x' })).toBe('Priced out: x');
    expect(
      line('waiting_for_budget', {
        minimum_sol: '0.3',
        spent_24h_sol: '0.8',
        daily_cap_sol: '1',
        until: t,
      }),
    ).toBe(
      `No wake yet: the minimum bid (0.3 SOL) does not fit in what is left of your 24-hour cap (0.8 of 1 SOL spent). Checking again at ${clockTime(t)}, when enough of the oldest spend leaves the window.`,
    );
    expect(line('wake_started', { trigger: 'self_chosen' })).toBe(
      'Waking Claude Code (the next look it chose).',
    );
    expect(
      line('wake_finished', {
        decision: 'acquired',
        reason: 'Worth it',
        next_look_hours: 4,
        next_look_at: t,
      }),
    ).toBe(`acquired - Worth it. Next look around ${clockTime(t)}.`);
    expect(
      line('wake_finished', { decision: 'missing', next_look_hours: null, next_look_at: t }),
    ).toBe(`missing - no reason given. Next look around ${clockTime(t)}.`);
    expect(
      line('wake_finished', {
        skipped: 'no wake',
        error: 'could not start claude: ENOENT',
        retry_at: t,
      }),
    ).toBe(
      `Claude Code did not start: could not start claude: ENOENT. Trying again at ${clockTime(t)}.`,
    );
    expect(line('next_look_defaulted', { next_look_at: t }, { mode: 'dry' })).toBe(
      `Dry run: next look around ${clockTime(t)}.`,
    );
    expect(line('stopped', { reason: 'signal' })).toBe('Stopped. State saved.');
    expect(line('stopped', { reason: 'once' })).toBeNull();
    expect(line('board_unknown_event')).toBeNull();
  });

  it('clockTime is local HH:MM', () => {
    const d = new Date(2026, 9, 4, 7, 5);
    expect(clockTime(d.getTime())).toBe('07:05');
    expect(clockTime(d.toISOString())).toBe('07:05');
  });
});
