import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BOARD_OFFLINE_LINE,
  INIT_QUESTIONS,
  parsePositiveSol,
  readBoardMinimum,
  runInit,
  type InitDeps,
  type RehearsalInput,
} from '../../src/agent/init.js';
import { AGENT_GITIGNORE_LINES, readAgentSettings, readEnvFile } from '../../src/agent/folder.js';
import { claudeSettings, mcpConfig } from '../../src/agent/settings.js';
import type { InitArgs } from '../../src/cli.js';
import { loadKeypair } from '../../src/config.js';
import { MockRpc } from '../../src/rpc/MockRpc.js';
import type { Rpc } from '../../src/rpc/Rpc.js';
import { captureAll } from './capture.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-init-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BELIEF = 'Agents should say plainly who they act for.';

function initArgs(overrides: Partial<InitArgs> = {}): InitArgs {
  return {
    dir: 'agent',
    belief: null,
    maxBid: null,
    dailyCap: null,
    mode: null,
    newWallet: false,
    keypair: null,
    model: null,
    yes: false,
    force: false,
    skipRehearsal: true,
    ...overrides,
  };
}

/** A board holding 0.1 SOL: the minimum is floor(0.1 * 1.01) = 0.101 SOL. */
const board = (amount = 100_000_000n): MockRpc => new MockRpc({ amount });

interface RunOptions {
  input?: string;
  interactive?: boolean;
  deps?: Partial<InitDeps>;
}

async function run(
  args: InitArgs,
  options: RunOptions = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const input = new PassThrough();
  input.end(options.input ?? '');
  const code = await runInit(args, {
    cwd: dir,
    platform: 'posix',
    chmod: () => {},
    version: '9.9.9',
    rpc: board(),
    claudeMdExists: () => false,
    ...options.deps,
    io: {
      input,
      interactive: options.interactive ?? false,
      write: (t) => (out += t),
      writeErr: (t) => (err += t),
    },
  });
  return { code, out, err };
}

const agentDir = (): string => join(dir, 'agent');
const file = (name: string): string => join(agentDir(), name);
const text = (name: string): string => readFileSync(file(name), 'utf8');

const quick = (overrides: Partial<InitArgs> = {}): InitArgs =>
  initArgs({ belief: BELIEF, maxBid: '0.2', yes: true, newWallet: true, ...overrides });

describe('parsePositiveSol', () => {
  it('accepts a positive amount with up to 9 decimals, in canonical form', () => {
    expect(parsePositiveSol('0.20')).toBe('0.2');
    expect(parsePositiveSol(' 1 ')).toBe('1');
    expect(parsePositiveSol('0.000000001')).toBe('0.000000001');
  });
  it('refuses zero, negatives, 10 decimals and anything not a plain decimal', () => {
    for (const bad of ['0', '0.0', '-1', '1.0000000001', 'abc', '1e3', '', '.5', '1,5']) {
      expect(parsePositiveSol(bad)).toBeNull();
    }
  });
});

describe('readBoardMinimum', () => {
  it('returns the minimum bid of the board account', async () => {
    expect(await readBoardMinimum(board())).toBe(101_000_000n);
  });
  it('returns null on an RPC error, a missing account or a timeout, and never throws', async () => {
    const failing = { getAccount: () => Promise.reject(new Error('offline')) };
    const missing = { getAccount: () => Promise.resolve(null) };
    const hanging = { getAccount: () => new Promise<Buffer | null>(() => {}) };
    expect(await readBoardMinimum(failing)).toBeNull();
    expect(await readBoardMinimum(missing)).toBeNull();
    expect(await readBoardMinimum(hanging, 20)).toBeNull();
  });
});

describe('init with flags', () => {
  it('--yes writes every file with the defaults and closes with the address to fund', async () => {
    const { code, out, err } = await run(quick());
    expect(code).toBe(0);
    expect(err).toBe('');

    const env = readEnvFile(file('.env'));
    expect(env).toEqual({
      BILLBOARD_KEYPAIR: file('wallet.keypair.json'),
      MAX_BID_SOL: '0.2',
      DAILY_CAP_SOL: '0.4', // 2 x max bid
      AUTO_BID: 'false', // propose is the default
      INTENT_PATH: './intent.md',
    });
    const publicKey = loadKeypair(file('wallet.keypair.json')).publicKey.toBase58();

    expect(text('intent.md')).toContain(`> ${BELIEF}`);
    expect(text('intent.md')).toContain('at most 0.2 SOL for one bid');
    expect(JSON.parse(text('.mcp.json'))).toEqual(
      mcpConfig({ platform: 'posix', version: '9.9.9' }),
    );
    expect(JSON.parse(text('.claude/settings.json'))).toEqual(claudeSettings());
    expect(text('.gitignore')).toBe(`${AGENT_GITIGNORE_LINES.join('\n')}\n`);
    expect(readAgentSettings(file('agent.json')).model).toBeNull();
    expect(existsSync(file('.mcp.sandbox.json'))).toBe(false);

    expect(out).toContain('Agent folder: agent\n');
    for (const name of ['wallet.keypair.json', 'intent.md', '.env', 'agent.json', '.mcp.json']) {
      expect(out).toContain(`  ${name}`);
    }
    expect(out).toContain('.claude/settings.json');
    expect(out).toContain('Rehearsal skipped (--skip-rehearsal).');
    expect(
      out.endsWith(
        [
          `Your agent's wallet: ${publicKey}`,
          'Fund it with 0.22 SOL to go live (0.02 covers fees).',
          "The board's minimum bid right now: 0.101 SOL",
          'Next:  cd agent',
          '       npx agent-billboard-mcp run --sandbox     (one rehearsal wake with your own Claude Code)',
          '       npx agent-billboard-mcp run               (live; auto mode only)',
          '       npx agent-billboard-mcp report',
          '',
        ].join('\n'),
      ),
    ).toBe(true);
  });

  it('auto mode, an explicit cap and a model land in .env and agent.json', async () => {
    const { code } = await run(
      quick({ mode: 'auto', dailyCap: '0.50', model: 'claude-sonnet-5', maxBid: '0.25' }),
    );
    expect(code).toBe(0);
    const env = readEnvFile(file('.env'));
    expect(env.AUTO_BID).toBe('true');
    expect(env.MAX_BID_SOL).toBe('0.25');
    expect(env.DAILY_CAP_SOL).toBe('0.5');
    expect(readAgentSettings(file('agent.json')).model).toBe('claude-sonnet-5');
    expect(text('intent.md')).toContain('You act on your own inside those limits.');
  });

  it('writes the Windows shape of .mcp.json when the platform is win32', async () => {
    await run(quick(), { deps: { platform: 'win32' } });
    expect(JSON.parse(text('.mcp.json'))).toEqual(
      mcpConfig({ platform: 'win32', version: '9.9.9' }),
    );
    expect(JSON.parse(text('.mcp.json')).mcpServers['agent-billboard'].command).toBe('cmd');
  });

  it('without a terminal, every missing answer is an error naming its flag, before any network call', async () => {
    const rpc = board();
    const spy = vi.spyOn(rpc, 'getAccount');
    const { code, out, err } = await run(initArgs(), { deps: { rpc } });
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain(
      'missing --belief, --max-bid, --daily-cap, --mode, --new-wallet or --keypair.',
    );
    expect(err).toContain('stdin is not a terminal');
    expect(err).toContain("Run 'agent-billboard-mcp init --help' for usage.");
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(agentDir())).toBe(false);
  });

  it('--yes never asks, even on a terminal: only the answers with no default are required', async () => {
    const { code, err } = await run(initArgs({ yes: true, maxBid: '0.2' }), { interactive: true });
    expect(code).toBe(2);
    expect(err).toContain('missing --belief. --yes never asks');
    expect(existsSync(agentDir())).toBe(false);
  });

  it('refuses bad flag values by name and writes nothing', async () => {
    const cases: Array<[Partial<InitArgs>, string]> = [
      [{ maxBid: '0' }, '--max-bid must be a SOL amount above 0 with at most 9 decimals'],
      [{ maxBid: '1.0000000001' }, '--max-bid must be'],
      [{ maxBid: 'abc' }, '--max-bid must be'],
      [{ dailyCap: '-1' }, '--daily-cap must be'],
      [{ dailyCap: '0.1' }, '--daily-cap (0.1 SOL) cannot be below --max-bid (0.2 SOL)'],
      [{ belief: '   ' }, '--belief: the belief is empty'],
      [{ belief: 'x'.repeat(601) }, '--belief: the belief is 601 characters; the most is 600'],
      [{ keypair: 'nowhere.json', newWallet: false }, '--keypair: no keypair file exists'],
    ];
    for (const [overrides, message] of cases) {
      const { code, err } = await run(quick(overrides));
      expect(code, message).toBe(2);
      expect(err).toContain(message);
    }
    expect(existsSync(agentDir())).toBe(false);
  });

  it('a belief of exactly 600 characters (emoji count as one) is accepted', async () => {
    const { code } = await run(quick({ belief: '🙂'.repeat(600) }));
    expect(code).toBe(0);
  });

  it('--keypair uses an existing file where it is and creates no wallet', async () => {
    const existing = Keypair.generate();
    const path = join(dir, 'mine.json');
    writeFileSync(path, JSON.stringify(Array.from(existing.secretKey)));
    const { code, out } = await run(quick({ newWallet: false, keypair: 'mine.json' }));
    expect(code).toBe(0);
    expect(readEnvFile(file('.env')).BILLBOARD_KEYPAIR).toBe(path);
    expect(existsSync(file('wallet.keypair.json'))).toBe(false);
    expect(out).toContain(`your keypair file at ${path}, used where it is`);
    expect(out).toContain(`Your agent's wallet: ${existing.publicKey.toBase58()}`);
  });

  it('quotes the folder in the cd line when it holds a space', async () => {
    const { out } = await run(quick({ dir: 'my agent' }));
    expect(out).toContain('Next:  cd "my agent"\n');
  });
});

describe('the live minimum', () => {
  it('warns when the per-bid limit is below the board minimum', async () => {
    // 1 SOL on the board: minimum floor(1 * 1.01) = 1.01 SOL, above 0.2.
    const { out } = await run(quick(), { deps: { rpc: board(1_000_000_000n) } });
    expect(out).toContain("The board's minimum bid right now: 1.01 SOL");
    expect(
      out
        .trimEnd()
        .endsWith(
          "Your per-bid limit is below the board's minimum. The price only goes up, so this agent cannot post until you raise MAX_BID_SOL in .env.",
        ),
    ).toBe(true);
  });

  it('says nothing more when the limit covers the minimum (0.101 <= 0.2)', async () => {
    const { out } = await run(quick());
    expect(out).not.toContain('below the board');
  });

  it('offline: the offline line, no warning, and setup still finishes', async () => {
    const rpc = { getAccount: () => Promise.reject(new Error('ENOTFOUND')) } satisfies Pick<
      Rpc,
      'getAccount'
    >;
    const { code, out } = await run(quick(), { deps: { rpc } });
    expect(code).toBe(0);
    expect(out).toContain(`${BOARD_OFFLINE_LINE}\nNext:`);
    expect(out).not.toContain('below the board');
  });

  it('a board read that hangs gives up after the timeout', async () => {
    const rpc = { getAccount: () => new Promise<Buffer | null>(() => {}) };
    const { code, out } = await run(quick(), { deps: { rpc, boardTimeoutMs: 30 } });
    expect(code).toBe(0);
    expect(out).toContain(BOARD_OFFLINE_LINE);
  });
});

describe('init on a terminal', () => {
  it('asks the four questions in order, re-asks a bad answer, and takes the defaults on Enter', async () => {
    const { code, out } = await run(initArgs(), {
      interactive: true,
      input: `  ${BELIEF}  \nabc\n0.5\n\nauto\n\n`,
    });
    expect(code).toBe(0);

    const order = [
      INIT_QUESTIONS.belief,
      'The minimum bid on the board right now is 0.101 SOL.',
      INIT_QUESTIONS.maxBid,
      'Give a SOL amount above 0 with at most 9 decimals, like 0.25.',
      INIT_QUESTIONS.maxBid,
      INIT_QUESTIONS.dailyCap('1'),
      INIT_QUESTIONS.modeAuto,
      INIT_QUESTIONS.modePropose,
      INIT_QUESTIONS.mode,
      INIT_QUESTIONS.wallet,
      'Agent folder: agent',
    ];
    let at = 0;
    for (const expected of order) {
      const found = out.indexOf(expected, at);
      expect(found, expected).toBeGreaterThanOrEqual(at);
      at = found + expected.length;
    }
    expect(INIT_QUESTIONS.dailyCap('1')).toBe('The most it may spend in any 24 hours, in SOL. [1]');

    const env = readEnvFile(file('.env'));
    expect(env.MAX_BID_SOL).toBe('0.5');
    expect(env.DAILY_CAP_SOL).toBe('1');
    expect(env.AUTO_BID).toBe('true');
    expect(text('intent.md')).toContain(`> ${BELIEF}\n`);
    expect(existsSync(file('wallet.keypair.json'))).toBe(true);
  });

  it('asks only what the flags left out', async () => {
    const { code, out } = await run(initArgs({ belief: BELIEF, maxBid: '0.2', newWallet: true }), {
      interactive: true,
      input: '0.3\npropose\n',
    });
    expect(code).toBe(0);
    expect(out).not.toContain(INIT_QUESTIONS.belief);
    expect(out).not.toContain(INIT_QUESTIONS.maxBid);
    expect(out).not.toContain('The minimum bid on the board right now is');
    expect(out).not.toContain(INIT_QUESTIONS.wallet);
    expect(readEnvFile(file('.env')).DAILY_CAP_SOL).toBe('0.3');
  });

  it('refuses a daily cap below the per-bid limit and a mode it does not know', async () => {
    const { code, out } = await run(initArgs({ belief: BELIEF, newWallet: true }), {
      interactive: true,
      input: '0.5\n0.4\n0.6\nmaybe\npropose\n',
    });
    expect(code).toBe(0);
    expect(out).toContain('The daily cap cannot be below the per-bid limit (0.5 SOL).');
    expect(out).toContain('Answer propose or auto.');
    expect(readEnvFile(file('.env')).DAILY_CAP_SOL).toBe('0.6');
    expect(readEnvFile(file('.env')).AUTO_BID).toBe('false');
  });

  it('shows the offline line before the per-bid question when the board cannot be read', async () => {
    const rpc = { getAccount: () => Promise.reject(new Error('offline')) };
    const { out } = await run(initArgs({ newWallet: true }), {
      interactive: true,
      input: `${BELIEF}\n0.2\n\n\n`,
      deps: { rpc },
    });
    expect(out.indexOf(BOARD_OFFLINE_LINE)).toBeLessThan(out.indexOf(INIT_QUESTIONS.maxBid));
  });

  it('no to a new wallet: asks for a keypair path until one loads', async () => {
    const existing = Keypair.generate();
    writeFileSync(join(dir, 'k.json'), JSON.stringify(Array.from(existing.secretKey)));
    const { code, out } = await run(initArgs(), {
      interactive: true,
      input: `${BELIEF}\n0.2\n\npropose\nn\nmissing.json\nk.json\n`,
    });
    expect(code).toBe(0);
    expect(out).toContain(INIT_QUESTIONS.keypairPath);
    expect(out).toContain('No keypair file exists at the path given');
    expect(readEnvFile(file('.env')).BILLBOARD_KEYPAIR).toBe(join(dir, 'k.json'));
    expect(existsSync(file('wallet.keypair.json'))).toBe(false);
  });

  it('input that ends before the last answer is a refusal and writes nothing', async () => {
    const { code, err } = await run(initArgs(), { interactive: true, input: `${BELIEF}\n` });
    expect(code).toBe(2);
    expect(err).toContain('input ended before every question was answered');
    expect(existsSync(agentDir())).toBe(false);
  });
});

describe('overwrite rules', () => {
  it('an existing agent stops init before it asks anything, unless --force', async () => {
    expect((await run(quick())).code).toBe(0);
    const before = text('intent.md');
    const { code, err } = await run(quick({ belief: 'Something else entirely.' }));
    expect(code).toBe(2);
    expect(err).toContain(
      'already holds an agent (intent.md, .env, agent.json, .mcp.json, .claude/settings.json)',
    );
    expect(err).toContain('Use --force');
    expect(text('intent.md')).toBe(before);
  });

  it('a second init --force never touches an existing wallet.keypair.json', async () => {
    expect((await run(quick())).code).toBe(0);
    const keyPath = file('wallet.keypair.json');
    const bytes = readFileSync(keyPath);
    const stat = statSync(keyPath);
    const publicKey = loadKeypair(keyPath).publicKey.toBase58();

    // The operator adds their own key and tunes a runner setting.
    writeFileSync(file('.env'), `${text('.env')}MY_NOTE=keep me\n`);
    const settings = JSON.parse(text('agent.json')) as Record<string, unknown>;
    writeFileSync(file('agent.json'), JSON.stringify({ ...settings, max_wakes_24h: 3 }));

    const { code, out } = await run(
      quick({ force: true, newWallet: true, belief: 'A new belief.', maxBid: '0.3' }),
    );
    expect(code).toBe(0);
    expect(readFileSync(keyPath).equals(bytes)).toBe(true);
    expect(statSync(keyPath).mtimeMs).toBe(stat.mtimeMs);
    expect(statSync(keyPath).ino).toBe(stat.ino);
    expect(out).toContain('kept: a keypair file is never overwritten');
    expect(out).toContain(`Your agent's wallet: ${publicKey}`);

    const env = readEnvFile(file('.env'));
    expect(env.BILLBOARD_KEYPAIR).toBe(keyPath);
    expect(env.MAX_BID_SOL).toBe('0.3');
    expect(env.MY_NOTE).toBe('keep me');
    expect(readAgentSettings(file('agent.json')).max_wakes_24h).toBe(3);
    expect(text('intent.md')).toContain('> A new belief.');
  });

  it('.gitignore is merged, never replaced', async () => {
    mkdirSync(agentDir());
    writeFileSync(file('.gitignore'), 'node_modules\n.env\n');
    await run(quick());
    const lines = text('.gitignore').split('\n');
    expect(lines[0]).toBe('node_modules');
    expect(lines.filter((l) => l === '.env')).toHaveLength(1);
    for (const line of AGENT_GITIGNORE_LINES) expect(lines).toContain(line);
  });
});

describe('the CLAUDE.md warning', () => {
  it('warns for every CLAUDE.md in the folder or above it, and still finishes', async () => {
    const ancestor = join(dir, 'CLAUDE.md');
    const { code, err } = await run(quick(), {
      deps: { claudeMdExists: (p) => p === ancestor },
    });
    expect(code).toBe(0);
    expect(err).toBe(
      `Warning: A CLAUDE.md at ${ancestor} would be loaded into your agent's context. Move the folder or remove that file.\n`,
    );
  });
});

describe('the rehearsal hook', () => {
  it('runs after the files and before the closing lines, with the answers', async () => {
    const seen: RehearsalInput[] = [];
    const rehearse = async (input: RehearsalInput): Promise<void> => {
      seen.push(input);
      input.line('SANDBOX test line');
    };
    const { out } = await run(quick({ skipRehearsal: false, mode: 'auto' }), {
      deps: { rehearse },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      belief: BELIEF,
      maxBidSol: '0.2',
      dailyCapSol: '0.4',
      mode: 'auto',
    });
    expect(seen[0]?.paths.dir).toBe(agentDir());
    expect(out.indexOf('Agent folder:')).toBeLessThan(out.indexOf('SANDBOX test line'));
    expect(out.indexOf('SANDBOX test line')).toBeLessThan(out.indexOf("Your agent's wallet:"));
  });

  it('--skip-rehearsal never calls it', async () => {
    const rehearse = vi.fn(async () => {});
    await run(quick({ skipRehearsal: true }), { deps: { rehearse } });
    expect(rehearse).not.toHaveBeenCalled();
  });
});

describe('the secret never reaches the output of init', () => {
  it('new wallet, --force rerun, --keypair and a bad --keypair print no encoding of either key', async () => {
    const other = Keypair.generate();
    writeFileSync(join(dir, 'other.json'), JSON.stringify(Array.from(other.secretKey)));
    const deps: InitDeps = {
      cwd: dir,
      platform: 'posix',
      chmod: () => {},
      rpc: board(),
      claudeMdExists: () => false,
      io: { interactive: false }, // stdout and stderr stay the real streams, captured below
    };

    const output = await captureAll(async () => {
      await runInit(quick({ skipRehearsal: false }), deps);
      await runInit(quick({ force: true }), deps);
      await runInit(quick({ dir: 'b', newWallet: false, keypair: 'other.json' }), deps);
      // The secret pasted where the path goes.
      await runInit(
        quick({ dir: 'c', newWallet: false, keypair: bs58.encode(other.secretKey) }),
        deps,
      );
    });

    expect(output).toContain("Your agent's wallet:");
    expect(output).toContain('--keypair: no keypair file exists at the path given');
    const own = Uint8Array.from(
      JSON.parse(readFileSync(file('wallet.keypair.json'), 'utf8')) as number[],
    );
    for (const secret of [own, other.secretKey]) {
      const bytes = Array.from(secret);
      const seed = secret.slice(0, 32);
      for (const enc of [
        JSON.stringify(bytes),
        bytes.join(', '),
        bytes.join(','),
        bs58.encode(secret),
        bs58.encode(seed),
        Buffer.from(secret).toString('hex'),
        Buffer.from(secret).toString('base64'),
        Buffer.from(seed).toString('hex'),
        Buffer.from(seed).toString('base64'),
      ]) {
        expect(output).not.toContain(enc);
      }
    }
  });
});
