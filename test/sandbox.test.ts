/**
 * The sandbox wiring (S2): which RPC a sandbox session gets, what it does
 * not reach for, and what each scenario looks like on the first read.
 *
 * The rehearsal walk itself lands here in S6.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRuntime } from '../src/cli.js';
import { loadConfig, type SandboxScenario } from '../src/config.js';
import { MockRpc } from '../src/rpc/MockRpc.js';
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
import { getFlipHistory } from '../src/tools/get_flip_history.js';
import { readBillboard } from '../src/tools/read_billboard.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-sandbox-'));
});
afterEach(() => {
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
