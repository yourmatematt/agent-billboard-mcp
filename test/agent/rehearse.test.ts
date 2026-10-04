import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentPaths, type AgentPaths } from '../../src/agent/folder.js';
import { runInit, type InitDeps, type RehearsalInput } from '../../src/agent/init.js';
import { renderIntent, type AgentMode } from '../../src/agent/intent-template.js';
import {
  REHEARSAL_MESSAGE_BYTES,
  RehearsalError,
  rehearsalMessage,
  rehearse,
  type RehearsalResult,
} from '../../src/agent/rehearse.js';
import type { InitArgs } from '../../src/cli.js';
import { MOCK_SIGNATURE_RE, MockRpc } from '../../src/rpc/MockRpc.js';
import { SANDBOX_PREVIOUS_POSTER } from '../../src/sandbox.js';
import { ACQUIRE_TOOL } from '../../src/tools/acquire_posting_rights.js';
import { APPROVE_TOOL } from '../../src/tools/approve_proposal.js';
import { READ_BILLBOARD_TOOL } from '../../src/tools/read_billboard.js';

let root: string;
let tmpRoot: string;
let paths: AgentPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abm-rehearse-'));
  tmpRoot = join(root, 'tmp');
  mkdirSync(tmpRoot);
  paths = agentPaths('agent', root);
  mkdirSync(paths.dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const BELIEF = 'Agents should say plainly who they act for.';

interface Walked {
  result: RehearsalResult;
  lines: string[];
}

/** Writes intent.md the way init does, then rehearses against it. */
async function walk(
  overrides: Partial<Omit<RehearsalInput, 'paths' | 'line'>> = {},
): Promise<Walked> {
  const input = {
    belief: BELIEF,
    maxBidSol: '0.2',
    dailyCapSol: '0.4',
    mode: 'propose' as AgentMode,
    ...overrides,
  };
  writeFileSync(paths.intent, renderIntent(input));
  const lines: string[] = [];
  const result = await rehearse({ ...input, paths, line: (t) => lines.push(t) }, { tmpRoot });
  return { result, lines };
}

const tools = (result: RehearsalResult): string[] =>
  result.steps.map((s) =>
    s.tool === ACQUIRE_TOOL ? `${s.tool}:${String(s.structured['status'])}` : s.tool,
  );

describe('rehearsalMessage', () => {
  it('keeps a short belief whole', () => {
    expect(rehearsalMessage(BELIEF)).toBe(BELIEF);
  });

  it('cuts at 200 UTF-8 bytes, never inside a character', () => {
    // 'a' then 66 three-byte characters: 1 + 198 = 199 bytes fit; the next would make 202.
    const belief = `a${'€'.repeat(100)}`;
    const cut = rehearsalMessage(belief);
    expect(Buffer.byteLength(cut, 'utf8')).toBe(199);
    expect(cut).toBe(`a${'€'.repeat(66)}`);
    expect(Buffer.byteLength(rehearsalMessage('x'.repeat(600)), 'utf8')).toBe(
      REHEARSAL_MESSAGE_BYTES,
    );
  });
});

describe('the rehearsal in propose mode', () => {
  it('reads, dry-runs, proposes, approves and reads back as the poster', async () => {
    const { result } = await walk({ mode: 'propose' });
    expect(result.outcome).toBe('acquired');
    expect(tools(result)).toEqual([
      READ_BILLBOARD_TOOL,
      `${ACQUIRE_TOOL}:dry_run`,
      `${ACQUIRE_TOOL}:proposed`,
      APPROVE_TOOL,
      READ_BILLBOARD_TOOL,
    ]);
    const approved = result.steps[3]!.structured;
    expect(approved['status']).toBe('executed');
    expect((approved['signatures'] as string[])[0]).toMatch(MOCK_SIGNATURE_RE);
    const last = result.steps[4]!.structured;
    expect(last['you_are_poster']).toBe(true);
    expect(last['poster']).toBe(result.wallet);
    expect(last['message']).toBe(BELIEF);
    expect(last['amount_sol']).toBe('0.101');
  });

  it('prints one SANDBOX line per step, every line starting SANDBOX', async () => {
    const { lines } = await walk({ mode: 'propose' });
    expect(lines).toHaveLength(7);
    for (const line of lines) expect(line.startsWith('SANDBOX ')).toBe(true);
    expect(lines[1]).toContain('read_billboard: a simulated poster holds the board at 0.1 SOL');
    expect(lines[1]).toContain('the minimum bid is 0.101 SOL');
    expect(lines[1]).toContain('Your intent.md came back as operator.intent.');
    expect(lines[2]).toContain('acquire_posting_rights, dry run: 0.101 SOL');
    expect(lines[2]).toContain('paid back 0.1005 SOL');
    expect(lines[2]).toContain('Within your limits.');
    expect(lines[3]).toMatch(/^SANDBOX acquire_posting_rights: proposed \(.+\)\. In propose mode/);
    expect(lines[4]).toBe(
      'SANDBOX approve_proposal: approved. Acquired at 0.101 SOL in 1 simulated transaction, signed by the throwaway wallet.',
    );
    expect(lines[5]).toBe(
      'SANDBOX read_billboard: you_are_poster: true. Your message is up at 0.101 SOL.',
    );
    expect(lines[6]).toContain('Rehearsal passed.');
  });

  it('hands the server the operator brief and limits, and nothing else', async () => {
    vi.stubEnv('MAX_BID_SOL', '100');
    vi.stubEnv('AUTO_BID', 'true');
    vi.stubEnv('HISTORY_URL', 'https://site.example.com/history.json');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = await walk({ mode: 'propose', maxBidSol: '0.2', dailyCapSol: '0.3' });
    const operator = result.steps[0]!.structured['operator'] as {
      wallet: string;
      intent: string;
      limits: Record<string, unknown>;
    };
    expect(operator.intent).toBe(readFileSync(paths.intent, 'utf8'));
    expect(operator.limits).toMatchObject({
      max_bid_sol: '0.2',
      daily_cap_sol: '0.3',
      spent_last_24h_sol: '0',
      auto_bid: false,
      read_only: false,
    });
    // A throwaway wallet, not anything the operator holds.
    expect(operator.wallet).toBe(result.wallet);
    expect(result.wallet).not.toBe(SANDBOX_PREVIOUS_POSTER.publicKey.toBase58());
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('the rehearsal in auto mode', () => {
  it('acquires on the real call with no approval, then reads back as the poster', async () => {
    const { result, lines } = await walk({ mode: 'auto' });
    expect(result.outcome).toBe('acquired');
    expect(tools(result)).toEqual([
      READ_BILLBOARD_TOOL,
      `${ACQUIRE_TOOL}:dry_run`,
      `${ACQUIRE_TOOL}:executed`,
      READ_BILLBOARD_TOOL,
    ]);
    expect(tools(result)).not.toContain(APPROVE_TOOL);
    expect(result.steps[3]!.structured['you_are_poster']).toBe(true);
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(line.startsWith('SANDBOX ')).toBe(true);
    expect(lines[3]).toBe(
      'SANDBOX acquire_posting_rights: acquired at 0.101 SOL in 1 simulated transaction, signed by the throwaway wallet. Auto mode: no approval asked, within your limits.',
    );
  });

  it('posts only the first 200 bytes of a long belief', async () => {
    const belief = `${'Plain words matter. '.repeat(29)}End.`; // 584 bytes
    const { result } = await walk({ mode: 'auto', belief });
    const posted = String(result.steps[3]!.structured['message']);
    expect(Buffer.byteLength(posted, 'utf8')).toBe(200);
    expect(belief.startsWith(posted)).toBe(true);
    expect(result.steps[1]!.structured['message_bytes']).toBe(200);
  });
});

describe('a per-bid limit below the sandbox minimum', () => {
  for (const mode of ['propose', 'auto'] as const) {
    it(`${mode}: the refusal is printed as a result, not an error, and nothing is acquired`, async () => {
      // The sandbox minimum is 0.101 SOL; 0.05 is under it.
      const { result, lines } = await walk({ mode, maxBidSol: '0.05', dailyCapSol: '0.1' });
      expect(result.outcome).toBe('refused_limit');
      expect(tools(result)).toEqual([
        READ_BILLBOARD_TOOL,
        `${ACQUIRE_TOOL}:dry_run`,
        `${ACQUIRE_TOOL}:refused`,
        READ_BILLBOARD_TOOL,
      ]);
      const dry = result.steps[1]!.structured['limits'] as { ok: boolean; reason: string };
      expect(dry).toMatchObject({ ok: false, reason: 'max_bid' });
      const refused = result.steps[2]!.structured;
      expect(refused['error']).toBe('limit_exceeded');
      expect(refused['transactions_sent']).toBe(0);
      expect(result.steps[3]!.structured['you_are_poster']).toBe(false);
      expect(result.steps[3]!.structured['amount_sol']).toBe('0.1');

      for (const line of lines) expect(line.startsWith('SANDBOX ')).toBe(true);
      expect(lines[2]).toContain('Your limits would refuse it (max_bid). Nothing signed.');
      expect(lines[3]).toMatch(/^SANDBOX acquire_posting_rights: refused, limit_exceeded\. /);
      expect(lines[3]).toContain('Nothing was signed: that is your limit working.');
      expect(lines[3]).toContain('Bid 0.101 SOL exceeds MAX_BID_SOL 0.05. Nothing was signed');
      expect(lines[4]).toBe(
        'SANDBOX read_billboard: you_are_poster: false. The board is unchanged at 0.1 SOL.',
      );
      expect(lines.at(-1)).toContain('your limits refused a bid at the simulated minimum');
    });
  }
});

describe('nothing is written to the agent folder', () => {
  it('leaves the folder exactly as it was, and removes its own temp folder', async () => {
    writeFileSync(
      paths.intent,
      renderIntent({ belief: BELIEF, maxBidSol: '0.2', dailyCapSol: '0.4', mode: 'auto' }),
    );
    const before = readdirSync(paths.dir).sort();
    const realLog = join(paths.dir, 'billboard-activity.jsonl');
    for (const mode of ['propose', 'auto'] as const) {
      await rehearse(
        { belief: BELIEF, maxBidSol: '0.2', dailyCapSol: '0.4', mode, paths, line: () => {} },
        { tmpRoot },
      );
    }
    expect(readdirSync(paths.dir).sort()).toEqual(before);
    expect(before).not.toContain('billboard-activity.jsonl');
    expect(before).not.toContain('billboard-sandbox-activity.jsonl');
    expect(() => readFileSync(realLog)).toThrow();
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('removes its temp folder even when the walk fails', async () => {
    // No intent.md and a limit the config loader refuses: the walk stops early.
    await expect(
      rehearse(
        {
          belief: BELIEF,
          maxBidSol: 'nope',
          dailyCapSol: '0.4',
          mode: 'auto',
          paths,
          line: () => {},
        },
        { tmpRoot },
      ),
    ).rejects.toThrow();
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(readdirSync(paths.dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Inside init
// ---------------------------------------------------------------------------

function initArgs(overrides: Partial<InitArgs> = {}): InitArgs {
  return {
    dir: 'agent2',
    belief: BELIEF,
    maxBid: '0.2',
    dailyCap: null,
    mode: null,
    newWallet: true,
    keypair: null,
    model: null,
    yes: true,
    force: false,
    skipRehearsal: false,
    ...overrides,
  };
}

async function runInitHere(
  args: InitArgs,
  deps: Partial<InitDeps> = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runInit(args, {
    cwd: root,
    platform: 'posix',
    chmod: () => {},
    version: '9.9.9',
    rpc: new MockRpc({ amount: 100_000_000n }),
    claudeMdExists: () => false,
    ...deps,
    io: { interactive: false, write: (t) => (out += t), writeErr: (t) => (err += t) },
  });
  return { code, out, err };
}

describe('init runs the rehearsal by default', () => {
  for (const mode of ['propose', 'auto'] as const) {
    it(`${mode}: SANDBOX lines between the files and the closing lines, exit 0`, async () => {
      const { code, out, err } = await runInitHere(initArgs({ mode }));
      expect(code).toBe(0);
      expect(err).toBe('');
      const sandboxLines = out.split('\n').filter((l) => l.startsWith('SANDBOX'));
      expect(sandboxLines.length).toBe(mode === 'propose' ? 7 : 6);
      expect(out).toContain('SANDBOX Rehearsal passed.');
      expect(out.indexOf('Agent folder:')).toBeLessThan(out.indexOf('SANDBOX'));
      expect(out.lastIndexOf('SANDBOX')).toBeLessThan(out.indexOf("Your agent's wallet:"));
      if (mode === 'propose') expect(out).toContain('SANDBOX approve_proposal: approved.');
      else expect(out).not.toContain('approve_proposal');
      // Nothing from the walk lands in the folder.
      const files = readdirSync(join(root, 'agent2'));
      expect(files.some((f) => f.endsWith('.jsonl'))).toBe(false);
    });
  }

  it('a per-bid limit below the sandbox minimum still finishes init with exit 0', async () => {
    const { code, out } = await runInitHere(initArgs({ maxBid: '0.05', mode: 'auto' }));
    expect(code).toBe(0);
    expect(out).toContain('SANDBOX acquire_posting_rights: refused, limit_exceeded.');
    expect(out).toContain("Your agent's wallet:");
    // The MockRpc board's minimum is 0.101 too, so the closing warning follows.
    expect(out).toContain("Your per-bid limit is below the board's minimum.");
  });

  it('a rehearsal that cannot finish is reported, the closing lines still print, exit 1', async () => {
    const rehearse = async (): Promise<void> => {
      throw new RehearsalError('acquire_posting_rights bid ended failed (transaction_failed)');
    };
    const { code, out, err } = await runInitHere(initArgs({ mode: 'auto' }), { rehearse });
    expect(code).toBe(1);
    expect(out).toContain(
      'SANDBOX Rehearsal did not finish: acquire_posting_rights bid ended failed (transaction_failed)',
    );
    expect(out).toContain("Your agent's wallet:");
    expect(err).toContain('the files are written, but the sandbox rehearsal did not finish');
    expect(readdirSync(join(root, 'agent2'))).toContain('intent.md');
  });
});
