import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIG_HELP,
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
