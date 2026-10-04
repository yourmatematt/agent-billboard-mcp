import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_COMMANDS,
  CONFIG_HELP,
  DEFAULT_INIT_DIR,
  commandHelpText,
  formatBanner,
  helpText,
  isMainModule,
  parseArgs,
  rpcHost,
} from '../src/cli.js';
import { CONFIG_VARS, loadConfig } from '../src/config.js';
import { readIntent } from '../src/intent.js';
import { BILLBOARD_ADDRESS, PROGRAM_ID } from '../src/program/layout.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../src/version.js';

const wallet = Keypair.generate();
const secret = bs58.encode(wallet.secretKey);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function config(env: NodeJS.ProcessEnv) {
  return loadConfig(
    { ACTIVITY_LOG_PATH: join(dir, 'log.jsonl'), INTENT_PATH: join(dir, 'intent.md'), ...env },
    { cwd: dir, dotenvPath: null },
  );
}

describe('parseArgs', () => {
  it('serves with no arguments', () => {
    expect(parseArgs([])).toEqual({ kind: 'serve' });
  });
  it('recognises help and version in long and short forms', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgs(['-v'])).toEqual({ kind: 'version' });
  });
  it('help wins over version when both are given', () => {
    expect(parseArgs(['--version', '--help'])).toEqual({ kind: 'help' });
  });
  it('rejects anything else', () => {
    expect(parseArgs(['--rpc', 'x'])).toEqual({
      kind: 'error',
      message: 'unknown argument: --rpc',
    });
  });
});

describe('parseArgs: commands', () => {
  const initDefaults = {
    dir: DEFAULT_INIT_DIR,
    belief: null,
    maxBid: null,
    dailyCap: null,
    mode: null,
    newWallet: false,
    keypair: null,
    model: null,
    yes: false,
    force: false,
    skipRehearsal: false,
  };
  const runDefaults = {
    dir: '.',
    sandbox: false,
    once: false,
    dryRun: false,
    claude: null,
    model: null,
    minutes: null,
  };

  it('init with no flags: default folder, everything else unset', () => {
    expect(parseArgs(['init'])).toEqual({ kind: 'init', args: initDefaults });
  });
  it('init with every flag, in both --flag value and --flag=value forms', () => {
    expect(
      parseArgs([
        'init',
        'my-agent',
        '--belief',
        'Small shops beat chains.',
        '--max-bid=0.2',
        '--daily-cap',
        '0.5',
        '--mode',
        'auto',
        '--new-wallet',
        '--model',
        'claude-sonnet-5',
        '--yes',
        '--force',
        '--skip-rehearsal',
      ]),
    ).toEqual({
      kind: 'init',
      args: {
        dir: 'my-agent',
        belief: 'Small shops beat chains.',
        maxBid: '0.2',
        dailyCap: '0.5',
        mode: 'auto',
        newWallet: true,
        keypair: null,
        model: 'claude-sonnet-5',
        yes: true,
        force: true,
        skipRehearsal: true,
      },
    });
  });
  it('init keeps a belief that starts with a single dash, and one passed with =', () => {
    const a = parseArgs(['init', '--belief', '-a dash first']);
    expect(a.kind === 'init' && a.args.belief).toBe('-a dash first');
    const b = parseArgs(['init', '--belief=--two dashes']);
    expect(b.kind === 'init' && b.args.belief).toBe('--two dashes');
  });
  it('init --keypair takes a path', () => {
    expect(parseArgs(['init', '--keypair', 'C:\\keys\\id.json', '--mode', 'propose'])).toEqual({
      kind: 'init',
      args: { ...initDefaults, keypair: 'C:\\keys\\id.json', mode: 'propose' },
    });
  });
  it('init refuses a bad mode, both wallet choices, and a missing value', () => {
    expect(parseArgs(['init', '--mode', 'yolo'])).toEqual({
      kind: 'error',
      message: 'init: --mode must be auto or propose, not yolo',
    });
    expect(parseArgs(['init', '--new-wallet', '--keypair', 'k.json'])).toEqual({
      kind: 'error',
      message: 'init: --new-wallet and --keypair cannot be used together',
    });
    expect(parseArgs(['init', '--belief'])).toEqual({
      kind: 'error',
      message: 'init: --belief needs a value',
    });
    expect(parseArgs(['init', '--max-bid', '--yes'])).toEqual({
      kind: 'error',
      message: 'init: --max-bid needs a value',
    });
    expect(parseArgs(['init', '--max-bid='])).toEqual({
      kind: 'error',
      message: 'init: --max-bid needs a value',
    });
  });

  it('run with no flags: this folder, live, looping', () => {
    expect(parseArgs(['run'])).toEqual({ kind: 'run', args: runDefaults });
  });
  it('run --sandbox implies --once', () => {
    expect(parseArgs(['run', '--sandbox'])).toEqual({
      kind: 'run',
      args: { ...runDefaults, sandbox: true, once: true },
    });
  });
  it('run with every flag', () => {
    expect(
      parseArgs([
        'run',
        'agents/one',
        '--once',
        '--dry-run',
        '--claude',
        '/opt/claude',
        '--model',
        'claude-haiku-4-5',
        '--minutes',
        '2',
      ]),
    ).toEqual({
      kind: 'run',
      args: {
        dir: 'agents/one',
        sandbox: false,
        once: true,
        dryRun: true,
        claude: '/opt/claude',
        model: 'claude-haiku-4-5',
        minutes: 2,
      },
    });
    const r = parseArgs(['run', '--minutes=0.5']);
    expect(r.kind === 'run' && r.args.minutes).toBe(0.5);
  });
  it('run refuses minutes that are not a positive number', () => {
    for (const bad of ['0', '-1', 'ten', '1e3', 'Infinity']) {
      expect(parseArgs(['run', `--minutes=${bad}`])).toEqual({
        kind: 'error',
        message: `run: --minutes must be a positive number, not ${bad}`,
      });
    }
  });

  it('report: defaults, --sandbox and --json', () => {
    expect(parseArgs(['report'])).toEqual({
      kind: 'report',
      args: { dir: '.', sandbox: false, json: false },
    });
    expect(parseArgs(['report', 'x', '--json', '--sandbox'])).toEqual({
      kind: 'report',
      args: { dir: 'x', sandbox: true, json: true },
    });
  });

  it('<command> --help and -h, anywhere after the command, win over flag errors', () => {
    for (const command of AGENT_COMMANDS) {
      expect(parseArgs([command, '--help'])).toEqual({ kind: 'command-help', command });
      expect(parseArgs([command, 'dir', '-h'])).toEqual({ kind: 'command-help', command });
    }
    expect(parseArgs(['init', '--mode', 'yolo', '--help'])).toEqual({
      kind: 'command-help',
      command: 'init',
    });
  });

  it('an unknown command names itself and the real ones', () => {
    expect(parseArgs(['serve'])).toEqual({
      kind: 'error',
      message: 'unknown command: serve (commands: init, run, report)',
    });
    expect(parseArgs(['INIT'])).toMatchObject({ kind: 'error' });
  });
  it("an unknown flag names the flag and the command, including another command's flag", () => {
    expect(parseArgs(['init', '--bogus'])).toEqual({
      kind: 'error',
      message: 'init: unknown flag: --bogus',
    });
    expect(parseArgs(['report', '--claude', 'x'])).toEqual({
      kind: 'error',
      message: 'report: unknown flag: --claude',
    });
    expect(parseArgs(['run', '--belief=x'])).toEqual({
      kind: 'error',
      message: 'run: unknown flag: --belief',
    });
    expect(parseArgs(['run', '-x'])).toEqual({ kind: 'error', message: 'run: unknown flag: -x' });
    expect(parseArgs(['run', '--version'])).toEqual({
      kind: 'error',
      message: 'run: unknown flag: --version',
    });
  });
  it('refuses a second folder, a repeated flag and a value on a switch', () => {
    expect(parseArgs(['run', 'a', 'b'])).toEqual({
      kind: 'error',
      message: 'run: unexpected argument: b (one folder only)',
    });
    expect(parseArgs(['init', '--yes', '--yes'])).toEqual({
      kind: 'error',
      message: 'init: --yes given twice',
    });
    expect(parseArgs(['report', '--json=true'])).toEqual({
      kind: 'error',
      message: 'report: --json takes no value',
    });
  });
  it('a command after a global flag is still an unknown argument, as in 0.4.0', () => {
    expect(parseArgs(['--help', 'init'])).toEqual({
      kind: 'error',
      message: 'unknown argument: init',
    });
  });
});

describe('commandHelpText', () => {
  const flags: Record<string, string[]> = {
    init: [
      '--belief',
      '--max-bid',
      '--daily-cap',
      '--mode',
      '--new-wallet',
      '--keypair',
      '--model',
      '--yes',
      '--force',
      '--skip-rehearsal',
    ],
    run: ['--sandbox', '--once', '--dry-run', '--claude', '--model', '--minutes'],
    report: ['--sandbox', '--json'],
  };
  it('lists every flag each command accepts', () => {
    for (const command of AGENT_COMMANDS) {
      const text = commandHelpText(command);
      expect(text).toContain(`Usage: ${PACKAGE_NAME} ${command} [dir]`);
      for (const flag of flags[command]!) expect(text).toContain(flag);
    }
  });
  it('every flag it lists is one the parser accepts', () => {
    for (const command of AGENT_COMMANDS) {
      for (const flag of flags[command]!) {
        const r = parseArgs([command, `${flag}=x`]);
        if (r.kind === 'error') expect(r.message).not.toContain('unknown flag');
      }
    }
  });
  it("run's help says every wake is a model call on the operator's own account", () => {
    expect(commandHelpText('run')).toContain(
      'Every wake is a model call on your own Claude account and usage.',
    );
  });
});

describe('version', () => {
  it('matches package.json', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as {
      version: string;
      name: string;
    };
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(PACKAGE_NAME).toBe(pkg.name);
    expect(PACKAGE_VERSION).not.toBe('0.0.0');
  });
});

describe('helpText', () => {
  it('documents every config variable, the three modes and both addresses', () => {
    const text = helpText();
    for (const v of CONFIG_VARS) {
      expect(text).toContain(v);
      expect(CONFIG_HELP[v].length).toBeGreaterThan(20);
    }
    expect(text).toContain('read-only');
    expect(text).toContain('propose');
    expect(text).toContain('auto');
    expect(text).toContain(PROGRAM_ID.toBase58());
    expect(text).toContain(BILLBOARD_ADDRESS.toBase58());
    expect(text).toContain(PACKAGE_VERSION);
  });
  it('keeps the 0.4.0 usage lines and adds a Commands block naming init, run and report', () => {
    const text = helpText();
    expect(text).toContain(
      `  ${PACKAGE_NAME}            start the server on stdin/stdout (for an MCP client)`,
    );
    expect(text).toContain(`  ${PACKAGE_NAME} --help     print this text`);
    expect(text).toContain(`  ${PACKAGE_NAME} --version  print the version`);
    expect(text).toContain('Commands (each has its own help');
    for (const command of AGENT_COMMANDS) {
      expect(text).toMatch(new RegExp(`^  ${command} \\[dir\\]`, 'm'));
    }
    expect(text.indexOf('Commands (')).toBeLessThan(text.indexOf('Modes (chosen by environment)'));
  });
});

describe('rpcHost', () => {
  it('keeps the host and drops the path, where API keys usually live', () => {
    expect(rpcHost('https://mainnet.helius-rpc.com/?api-key=SECRET123')).toBe(
      'mainnet.helius-rpc.com (https)',
    );
    expect(rpcHost('https://api.mainnet-beta.solana.com')).toBe(
      'api.mainnet-beta.solana.com (https)',
    );
    expect(rpcHost('not a url')).toBe('(unparseable RPC_URL)');
  });
});

describe('formatBanner', () => {
  it('read-only: states the mode, no wallet, no limits, intent missing', () => {
    const cfg = config({});
    const banner = formatBanner({
      config: cfg,
      intent: readIntent(cfg.intentPath),
      subscribed: false,
    });
    expect(banner).toContain(`${PACKAGE_NAME} v${PACKAGE_VERSION}`);
    expect(banner).toMatch(/mode\s+read-only/);
    expect(banner).not.toContain('wallet');
    expect(banner).toContain('nothing can be signed');
    expect(banner).toContain('api.mainnet-beta.solana.com (https)');
    expect(banner).toContain(`${BILLBOARD_ADDRESS.toBase58()} (PDA verified)`);
    expect(banner).toContain('not started (read-only)');
    expect(banner).toContain(cfg.activityLogPath);
    expect(banner).toContain(`not found at ${cfg.intentPath}`);
    expect(banner).toContain('derived on-chain');
  });

  it('propose: wallet pubkey, both limits, intent size, subscription state', () => {
    writeFileSync(join(dir, 'intent.md'), 'Post about the bakery.\n');
    const cfg = config({ BILLBOARD_KEYPAIR: secret, MAX_BID_SOL: '0.2', DAILY_CAP_SOL: '0.5' });
    const banner = formatBanner({
      config: cfg,
      intent: readIntent(cfg.intentPath),
      subscribed: true,
    });
    expect(banner).toMatch(/mode\s+propose/);
    expect(banner).toContain(wallet.publicKey.toBase58());
    expect(banner).toContain('max bid 0.2 SOL, daily cap 0.5 SOL');
    expect(banner).toContain('account changes via websocket');
    expect(banner).toMatch(/intent\s+.*intent\.md \(23 bytes\)/);
  });

  it('auto: says so, reports a failed subscription honestly, hides the RPC path and key', () => {
    const cfg = config({
      BILLBOARD_KEYPAIR: secret,
      MAX_BID_SOL: '0.2',
      AUTO_BID: 'true',
      RPC_URL: 'https://rpc.example.com/v1/KEY-abc',
      HISTORY_URL: 'https://site.example.com/history.json?token=T',
    });
    const banner = formatBanner({ config: cfg, intent: null, subscribed: false });
    expect(banner).toMatch(/mode\s+auto/);
    expect(banner).toContain('max bid 0.2 SOL, daily cap 0.2 SOL');
    expect(banner).toContain('unavailable, state is fetched on each read');
    expect(banner).toContain('rpc.example.com (https)');
    expect(banner).not.toContain('KEY-abc');
    expect(banner).toContain('HISTORY_URL site.example.com (https)');
    expect(banner).not.toContain('token=T');
  });

  it('never contains the secret key in any form', () => {
    const cfg = config({ BILLBOARD_KEYPAIR: secret, MAX_BID_SOL: '0.2' });
    const banner = formatBanner({ config: cfg, intent: null, subscribed: false });
    expect(banner).not.toContain(secret);
    expect(banner).not.toContain(JSON.stringify(Array.from(wallet.secretKey)));
  });

  it('sandbox: names the scenario, the ephemeral wallet and that mainnet is untouched', () => {
    const cfg = config({ BILLBOARD_SANDBOX: 'true' });
    const banner = formatBanner({ config: cfg, intent: null, subscribed: true });
    expect(banner).toMatch(/mode\s+sandbox \(propose\)/);
    expect(banner).toContain('scenario "default"');
    expect(banner).toContain(
      'Nothing here touches mainnet: no network call, no SOL, no transaction.',
    );
    expect(banner).toContain(
      `${cfg.keypair!.publicKey.toBase58()} (ephemeral, generated at start-up`,
    );
    expect(banner).toContain('simulated in process (RPC_URL is ignored; no network call is made)');
    expect(banner).toContain('simulated account changes, in process (no websocket is opened)');
    expect(banner).toContain('billboard-sandbox-activity.jsonl');
    expect(banner).not.toContain('api.mainnet-beta.solana.com');
  });

  it('sandbox: an idle scenario in auto mode says both', () => {
    const cfg = config({
      BILLBOARD_SANDBOX: 'true',
      BILLBOARD_SANDBOX_SCENARIO: 'idle',
      AUTO_BID: 'true',
    });
    const banner = formatBanner({ config: cfg, intent: null, subscribed: true });
    expect(banner).toMatch(/mode\s+sandbox \(auto\)/);
    expect(banner).toContain('scenario "idle": nobody has posted');
    expect(banner).toContain('max bid 1 SOL, daily cap 1 SOL');
  });

  it('reports an unreadable intent instead of hiding it', () => {
    const cfg = config({});
    const banner = formatBanner({ config: cfg, intent: { error: 'EACCES' }, subscribed: false });
    expect(banner).toContain(`unreadable at ${cfg.intentPath}: EACCES`);
  });
});

describe('isMainModule', () => {
  it('is false when the module is imported (as it is here)', () => {
    expect(isMainModule()).toBe(false);
    expect(isMainModule(undefined)).toBe(false);
    expect(isMainModule(join(dir, 'does-not-exist.js'))).toBe(false);
  });
});

// The compiled entrypoint. Built by `npm run build`; skipped when dist/ is
// absent so `npm test` alone still passes on a fresh clone.
const cliPath = join(process.cwd(), 'dist', 'cli.js');
const describeDist = existsSync(cliPath) ? describe : describe.skip;

describeDist('dist/cli.js', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      cwd: dir,
      timeout: 20_000,
    });

  it('--version prints the version to stdout only and exits 0', () => {
    const r = run(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(PACKAGE_VERSION);
    expect(r.stderr).toBe('');
  });

  it('--help prints usage to stdout with no env at all and exits 0', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('BILLBOARD_KEYPAIR');
    expect(r.stderr).toBe('');
  });

  it('an unknown argument exits 2 with the hint on stderr and nothing on stdout', () => {
    const r = run(['--bogus']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('unknown argument: --bogus');
    expect(r.stderr).toContain('--help');
  });

  it("<command> --help prints that command's help to stdout and exits 0", () => {
    for (const command of AGENT_COMMANDS) {
      const r = run([command, '--help']);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(commandHelpText(command));
      expect(r.stderr).toBe('');
    }
  });

  it('an unknown command exits 2 naming it, with the general hint', () => {
    const r = run(['frobnicate']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('unknown command: frobnicate');
    expect(r.stderr).toContain(`Run '${PACKAGE_NAME} --help'`);
  });

  it("an unknown flag on a command exits 2 naming it, with that command's hint", () => {
    const r = run(['run', '--bogus']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('run: unknown flag: --bogus');
    expect(r.stderr).toContain(`Run '${PACKAGE_NAME} run --help'`);
  });

  it('init without a terminal or flags exits 2 naming every missing flag, writing nothing', () => {
    const r = run(['init']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(
      'init: missing --belief, --max-bid, --daily-cap, --mode, --new-wallet or --keypair.',
    );
    expect(r.stderr).toContain(`Run '${PACKAGE_NAME} init --help'`);
    expect(existsSync(join(dir, 'billboard-agent'))).toBe(false);
  });

  it('run in a folder that is not an agent exits 2 with one sentence, starting nothing', () => {
    const r = run(['run']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(`run: There is no .env in ${dir}.`);
    expect(r.stderr).toContain(`Run '${PACKAGE_NAME} run --help'`);
    expect(existsSync(join(dir, 'logs'))).toBe(false);
  });

  it('a keypair without MAX_BID_SOL is a fatal config error naming the variable', () => {
    const r = spawnSync(process.execPath, [cliPath], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', BILLBOARD_KEYPAIR: secret },
      cwd: dir,
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('fatal');
    expect(r.stderr).toContain('MAX_BID_SOL');
    expect(r.stderr).not.toContain(secret);
  });
});
