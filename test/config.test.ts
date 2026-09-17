import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIG_VARS,
  ConfigError,
  DEFAULT_ACTIVITY_LOG_PATH,
  DEFAULT_INTENT_PATH,
  DEFAULT_RPC_URL,
  describeConfig,
  loadConfig,
  loadKeypair,
  mergeDotenv,
} from '../src/config.js';
import {
  DEFAULT_PROPOSAL_TTL_MIN,
  MAX_PROPOSAL_TTL_MIN,
  MIN_PROPOSAL_TTL_MIN,
} from '../src/proposals.js';

const kp = Keypair.generate();
const SECRET_B58 = bs58.encode(kp.secretKey);
const SECRET_JSON = JSON.stringify(Array.from(kp.secretKey));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-config-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Load with no .env file involved unless a test opts in. */
function load(env: NodeJS.ProcessEnv, dotenvPath: string | null = null) {
  return loadConfig(env, { cwd: dir, dotenvPath });
}

function expectConfigError(fn: () => unknown, pattern: RegExp): ConfigError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  expect((caught as Error).message).toMatch(pattern);
  return caught as ConfigError;
}

describe('read-only mode (no keypair)', () => {
  it('applies every default', () => {
    const cfg = load({});
    expect(cfg.readOnly).toBe(true);
    expect(cfg.mode).toBe('read-only');
    expect(cfg.keypair).toBeNull();
    expect(cfg.maxBidLamports).toBeNull();
    expect(cfg.dailyCapLamports).toBeNull();
    expect(cfg.autoBid).toBe(false);
    expect(cfg.rpcUrl).toBe(DEFAULT_RPC_URL);
    expect(cfg.rpcWsUrl).toBe('wss://api.mainnet-beta.solana.com');
    expect(cfg.intentPath).toBe(join(dir, DEFAULT_INTENT_PATH.replace('./', '')));
    expect(cfg.activityLogPath).toBe(join(dir, DEFAULT_ACTIVITY_LOG_PATH.replace('./', '')));
    expect(cfg.historyUrl).toBeNull();
  });

  it('MAX_BID_SOL without a keypair is accepted but stays null (nothing to sign with)', () => {
    const cfg = load({ MAX_BID_SOL: '1' });
    expect(cfg.readOnly).toBe(true);
    expect(cfg.maxBidLamports).toBeNull();
  });

  it('AUTO_BID=true without a keypair is still read-only', () => {
    const cfg = load({ AUTO_BID: 'true' });
    expect(cfg.mode).toBe('read-only');
    expect(cfg.autoBid).toBe(true);
  });

  it('blank strings count as unset', () => {
    const cfg = load({ BILLBOARD_KEYPAIR: '   ', MAX_BID_SOL: '', RPC_URL: '' });
    expect(cfg.readOnly).toBe(true);
    expect(cfg.rpcUrl).toBe(DEFAULT_RPC_URL);
  });
});

describe('write mode', () => {
  it('base58 keypair + MAX_BID_SOL gives propose mode, daily cap defaults to max bid', () => {
    const cfg = load({ BILLBOARD_KEYPAIR: SECRET_B58, MAX_BID_SOL: '0.25' });
    expect(cfg.readOnly).toBe(false);
    expect(cfg.mode).toBe('propose');
    expect(cfg.keypair?.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(cfg.maxBidLamports).toBe(250_000_000n);
    expect(cfg.dailyCapLamports).toBe(250_000_000n);
  });

  it('AUTO_BID=true gives auto mode (case-insensitive)', () => {
    expect(
      load({ BILLBOARD_KEYPAIR: SECRET_B58, MAX_BID_SOL: '0.25', AUTO_BID: 'TRUE' }).mode,
    ).toBe('auto');
    expect(
      load({ BILLBOARD_KEYPAIR: SECRET_B58, MAX_BID_SOL: '0.25', AUTO_BID: 'false' }).mode,
    ).toBe('propose');
  });

  it('explicit DAILY_CAP_SOL is honoured, including below MAX_BID_SOL', () => {
    const cfg = load({ BILLBOARD_KEYPAIR: SECRET_B58, MAX_BID_SOL: '1', DAILY_CAP_SOL: '0.5' });
    expect(cfg.maxBidLamports).toBe(1_000_000_000n);
    expect(cfg.dailyCapLamports).toBe(500_000_000n);
  });

  it('keypair file path (Solana CLI JSON) is accepted', () => {
    const path = join(dir, 'id.json');
    writeFileSync(path, SECRET_JSON);
    const cfg = load({ BILLBOARD_KEYPAIR: path, MAX_BID_SOL: '0.1' });
    expect(cfg.keypair?.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('keypair file path relative to cwd is accepted', () => {
    writeFileSync(join(dir, 'wallet.keypair.json'), SECRET_JSON);
    const cfg = load({ BILLBOARD_KEYPAIR: 'wallet.keypair.json', MAX_BID_SOL: '0.1' });
    expect(cfg.keypair?.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('keypair without MAX_BID_SOL is a start-up error that names the variable', () => {
    const err = expectConfigError(
      () => load({ BILLBOARD_KEYPAIR: SECRET_B58 }),
      /BILLBOARD_KEYPAIR is set but MAX_BID_SOL is not/,
    );
    expect(err.message).toMatch(/MAX_BID_SOL=/);
    expect(err.message).not.toContain(SECRET_B58);
  });

  it('keypair with DAILY_CAP_SOL but no MAX_BID_SOL is still an error', () => {
    expectConfigError(
      () => load({ BILLBOARD_KEYPAIR: SECRET_B58, DAILY_CAP_SOL: '1' }),
      /MAX_BID_SOL is not/,
    );
  });
});

describe('loadKeypair', () => {
  it('decodes base58', () => {
    expect(loadKeypair(SECRET_B58, dir).publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('reads a JSON file', () => {
    const path = join(dir, 'k.json');
    writeFileSync(path, SECRET_JSON);
    expect(loadKeypair(path, dir).publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('rejects a .json path that does not exist, naming the directory but not the value', () => {
    // The value is not echoed: nothing exists at it, so it could be a secret
    // that happened to end in `.json` (see test/adversarial.test.ts).
    const missing = join(dir, 'nope.json');
    const err = expectConfigError(() => loadKeypair(missing, dir), /no file exists there/);
    expect(err.message).toContain(dir);
    expect(err.message).not.toContain('nope.json');
  });

  it('rejects a file that is not JSON', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, 'not json');
    expectConfigError(() => loadKeypair(path, dir), /not valid JSON/);
  });

  it('rejects a JSON file with the wrong length', () => {
    const path = join(dir, 'short.json');
    writeFileSync(path, JSON.stringify(Array.from(kp.secretKey.slice(0, 32))));
    expectConfigError(() => loadKeypair(path, dir), /exactly 64 byte values/);
  });

  it('rejects a JSON file with out-of-range values', () => {
    const path = join(dir, 'range.json');
    writeFileSync(path, JSON.stringify(new Array(64).fill(300)));
    expectConfigError(() => loadKeypair(path, dir), /exactly 64 byte values/);
  });

  it('rejects garbage that is neither a path nor base58, without echoing it', () => {
    const garbage = 'this-is-not-base58-0OIl!';
    const err = expectConfigError(
      () => loadKeypair(garbage, dir),
      /neither an existing keypair file/,
    );
    expect(err.message).not.toContain(garbage);
  });

  it('rejects a base58 value of the wrong length (32-byte seed), without echoing it', () => {
    const seed = bs58.encode(kp.secretKey.slice(0, 32));
    const err = expectConfigError(() => loadKeypair(seed, dir), /decodes to 32 bytes/);
    expect(err.message).not.toContain(seed);
  });

  it('rejects 64 bytes that are not a consistent ed25519 keypair', () => {
    const bytes = new Uint8Array(kp.secretKey);
    bytes[63] = (bytes[63]! + 1) & 0xff; // corrupt the public half
    const bad = bs58.encode(bytes);
    const err = expectConfigError(() => loadKeypair(bad, dir), /not a valid ed25519 secret key/);
    expect(err.message).not.toContain(bad);
  });

  it('rejects an empty value', () => {
    expectConfigError(() => loadKeypair('   ', dir), /set but empty/);
  });
});

describe('the keypair formats an agent already has', () => {
  const PUBKEY_B58 = kp.publicKey.toBase58();
  const SEED_B58 = bs58.encode(kp.secretKey.slice(0, 32));

  /** Every rejection names the format received and lists the three accepted forms. */
  function expectRejected(fn: () => unknown, received: RegExp): string {
    const err = expectConfigError(fn, received);
    expect(err.message).toContain('Accepted: (1) a base58-encoded 64-byte secret key');
    expect(err.message).toContain('(2) the path to a Solana CLI keypair file');
    expect(err.message).toContain('(3) the path to a JSON file');
    return err.message;
  }

  it('accepts the 88-character base58 secret key a wallet exports', () => {
    // 64 bytes base58-encode to 87 or 88 characters, depending on the leading byte.
    expect(SECRET_B58.length).toBeGreaterThanOrEqual(87);
    expect(SECRET_B58.length).toBeLessThanOrEqual(88);
    expect(loadKeypair(SECRET_B58, dir).publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('accepts a Solana CLI keypair file (JSON array of 64 numbers)', () => {
    const path = join(dir, 'id.json');
    writeFileSync(path, SECRET_JSON);
    expect(loadKeypair(path, dir).publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('accepts a JSON file holding the base58 secret key as a string', () => {
    const path = join(dir, 'wallet.json');
    writeFileSync(path, JSON.stringify(SECRET_B58));
    expect(loadKeypair(path, dir).publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('accepts a file holding that base58 secret key unquoted, as some runtimes write it', () => {
    const path = join(dir, 'bare.json');
    writeFileSync(path, `${SECRET_B58}\n`);
    expect(loadKeypair(path, dir).publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('refuses a 32-byte seed, naming what arrived without echoing it', () => {
    const text = expectRejected(() => loadKeypair(SEED_B58, dir), /decodes to 32 bytes/);
    expect(text).toMatch(/seed or a public key/);
    expect(text).not.toContain(SEED_B58);
  });

  it('refuses a seed written as a Solana CLI file, saying what the file holds', () => {
    const path = join(dir, 'seed.json');
    writeFileSync(path, JSON.stringify(Array.from(kp.secretKey.slice(0, 32))));
    const text = expectRejected(() => loadKeypair(path, dir), /exactly 64 byte values/);
    expect(text).toContain('an array of 32 entries');
  });

  it('refuses a 44-character public key, as an env value or inside a file', () => {
    expect(PUBKEY_B58.length).toBeGreaterThanOrEqual(43);
    expect(PUBKEY_B58.length).toBeLessThanOrEqual(44);
    const fromEnv = expectRejected(() => loadKeypair(PUBKEY_B58, dir), /decodes to 32 bytes/);
    expect(fromEnv).toMatch(/needs the full keypair/);

    const path = join(dir, 'pub.json');
    writeFileSync(path, JSON.stringify(PUBKEY_B58));
    expectRejected(() => loadKeypair(path, dir), /decodes to 32 bytes/);
  });

  it('refuses a path with nothing at it, saying where it looked', () => {
    const text = expectRejected(
      () => loadKeypair(join(dir, 'missing.json'), dir),
      /no file exists there/,
    );
    expect(text).toContain(dir);
  });

  it('refuses a path that exists but cannot be read as a file', () => {
    const path = join(dir, 'adirectory.json');
    mkdirSync(path);
    expectRejected(() => loadKeypair(path, dir), /could not be read|no file exists there/);
  });

  it('refuses a file holding neither a byte array nor a base58 key', () => {
    const path = join(dir, 'junk.json');
    writeFileSync(path, '{ "publicKey": "not the secret" }');
    expectRejected(() => loadKeypair(path, dir), /keypair file must be a JSON array/);
  });

  it('refuses a file of prose, naming both forms it could have been', () => {
    const path = join(dir, 'prose.json');
    writeFileSync(path, 'my wallet is in 1password\n');
    expectRejected(() => loadKeypair(path, dir), /not valid JSON/);
  });

  it('never echoes the secret, whichever form it arrived in', () => {
    const truncated = bs58.encode(kp.secretKey.slice(0, 63));
    const stringFile = join(dir, 'string-short.json');
    writeFileSync(stringFile, JSON.stringify(truncated));
    const bareFile = join(dir, 'bare-short.json');
    writeFileSync(bareFile, truncated);

    const attempts: Array<[string, () => unknown]> = [
      ['base58 env value', () => loadKeypair(truncated, dir)],
      ['JSON string file', () => loadKeypair(stringFile, dir)],
      ['unquoted base58 file', () => loadKeypair(bareFile, dir)],
      ['secret used as a path', () => loadKeypair(`${SECRET_B58}.json`, dir)],
      ['secret as a JSON string in a missing file', () => loadKeypair(`${SEED_B58}.json`, dir)],
    ];
    for (const [label, attempt] of attempts) {
      let text = '';
      try {
        attempt();
      } catch (err) {
        text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      }
      expect(text.length, `${label} should throw`).toBeGreaterThan(0);
      expect(text, `${label} echoes the secret key`).not.toContain(SECRET_B58);
      expect(text, `${label} echoes the truncated secret key`).not.toContain(truncated);
      expect(text, `${label} echoes the seed`).not.toContain(SEED_B58);
    }
  });
});

describe('validation of the other variables', () => {
  it('MAX_BID_SOL with more than 9 decimals is rejected, naming the variable', () => {
    expectConfigError(
      () => load({ BILLBOARD_KEYPAIR: SECRET_B58, MAX_BID_SOL: '0.1234567891' }),
      /MAX_BID_SOL must be a SOL amount/,
    );
  });

  it('non-numeric SOL amounts are rejected', () => {
    expectConfigError(() => load({ MAX_BID_SOL: 'lots' }), /MAX_BID_SOL must be a SOL amount/);
    expectConfigError(() => load({ DAILY_CAP_SOL: '1e3' }), /DAILY_CAP_SOL must be a SOL amount/);
    expectConfigError(() => load({ DAILY_CAP_SOL: '-1' }), /DAILY_CAP_SOL must be a SOL amount/);
  });

  it('AUTO_BID must be true or false', () => {
    expectConfigError(() => load({ AUTO_BID: 'yes' }), /AUTO_BID must be "true" or "false"/);
  });

  it('PROPOSAL_TTL_MIN defaults to 60 minutes', () => {
    expect(load({}).proposalTtlMin).toBe(DEFAULT_PROPOSAL_TTL_MIN);
    expect(DEFAULT_PROPOSAL_TTL_MIN).toBe(60);
  });

  it('PROPOSAL_TTL_MIN accepts whole minutes from 1 to 1440', () => {
    expect(load({ PROPOSAL_TTL_MIN: '1' }).proposalTtlMin).toBe(MIN_PROPOSAL_TTL_MIN);
    expect(load({ PROPOSAL_TTL_MIN: ' 15 ' }).proposalTtlMin).toBe(15);
    expect(load({ PROPOSAL_TTL_MIN: '1440' }).proposalTtlMin).toBe(MAX_PROPOSAL_TTL_MIN);
  });

  it('PROPOSAL_TTL_MIN rejects fractions, non-numbers and out-of-range values', () => {
    expectConfigError(
      () => load({ PROPOSAL_TTL_MIN: '1.5' }),
      /PROPOSAL_TTL_MIN must be a whole number of minutes/,
    );
    expectConfigError(
      () => load({ PROPOSAL_TTL_MIN: 'an hour' }),
      /PROPOSAL_TTL_MIN must be a whole number of minutes/,
    );
    expectConfigError(
      () => load({ PROPOSAL_TTL_MIN: '-5' }),
      /PROPOSAL_TTL_MIN must be a whole number of minutes/,
    );
    expectConfigError(
      () => load({ PROPOSAL_TTL_MIN: '0' }),
      /PROPOSAL_TTL_MIN must be between 1 and 1440 minutes/,
    );
    expectConfigError(
      () => load({ PROPOSAL_TTL_MIN: '1441' }),
      /PROPOSAL_TTL_MIN must be between 1 and 1440 minutes/,
    );
  });

  it('RPC_URL must be http(s); the websocket URL is derived from it', () => {
    expectConfigError(() => load({ RPC_URL: 'ftp://x' }), /RPC_URL must use http or https/);
    expectConfigError(() => load({ RPC_URL: 'not a url' }), /RPC_URL must be a valid URL/);
    const cfg = load({ RPC_URL: 'http://localhost:8899' });
    expect(cfg.rpcWsUrl).toBe('ws://localhost:8899');
  });

  it('RPC_WS_URL overrides the derived websocket URL and must be ws(s)', () => {
    const cfg = load({ RPC_URL: 'https://rpc.example', RPC_WS_URL: 'wss://ws.example' });
    expect(cfg.rpcWsUrl).toBe('wss://ws.example');
    expectConfigError(
      () => load({ RPC_WS_URL: 'https://ws.example' }),
      /RPC_WS_URL must use ws or wss/,
    );
  });

  it('HISTORY_URL must be http(s)', () => {
    expect(load({ HISTORY_URL: 'https://site.example/history.json' }).historyUrl).toBe(
      'https://site.example/history.json',
    );
    expectConfigError(
      () => load({ HISTORY_URL: 'file:///etc/passwd' }),
      /HISTORY_URL must use http/,
    );
  });

  it('INTENT_PATH and ACTIVITY_LOG_PATH resolve against cwd', () => {
    const cfg = load({ INTENT_PATH: 'ops/intent.md', ACTIVITY_LOG_PATH: 'logs/a.jsonl' });
    expect(cfg.intentPath).toBe(join(dir, 'ops', 'intent.md'));
    expect(cfg.activityLogPath).toBe(join(dir, 'logs', 'a.jsonl'));
  });

  it('reports every problem at once', () => {
    const err = expectConfigError(
      () => load({ AUTO_BID: 'maybe', RPC_URL: 'nope', MAX_BID_SOL: 'x' }),
      /invalid configuration/,
    );
    expect(err.message).toContain('AUTO_BID');
    expect(err.message).toContain('RPC_URL');
    expect(err.message).toContain('MAX_BID_SOL');
  });

  it('ignores unrelated environment variables', () => {
    const cfg = load({ PATH: '/usr/bin', HOME: dir, SOMETHING_ELSE: 'x' });
    expect(cfg.readOnly).toBe(true);
  });
});

describe('.env handling', () => {
  it('is loaded from cwd when present and real env wins', () => {
    writeFileSync(
      join(dir, '.env'),
      ['RPC_URL=https://from-dotenv.example', 'AUTO_BID=true', 'MAX_BID_SOL=0.3'].join('\n'),
    );
    const cfg = loadConfig(
      { RPC_URL: 'https://from-env.example', BILLBOARD_KEYPAIR: SECRET_B58 },
      { cwd: dir },
    );
    expect(cfg.rpcUrl).toBe('https://from-env.example');
    expect(cfg.autoBid).toBe(true);
    expect(cfg.maxBidLamports).toBe(300_000_000n);
    expect(cfg.mode).toBe('auto');
  });

  it('a missing .env is not an error', () => {
    expect(() => loadConfig({}, { cwd: dir })).not.toThrow();
  });

  it('dotenvPath: null skips the file', () => {
    writeFileSync(join(dir, '.env'), 'RPC_URL=https://from-dotenv.example');
    expect(loadConfig({}, { cwd: dir, dotenvPath: null }).rpcUrl).toBe(DEFAULT_RPC_URL);
  });

  it('mergeDotenv never mutates the input env', () => {
    const path = join(dir, 'x.env');
    writeFileSync(path, 'RPC_URL=https://x.example');
    const env: NodeJS.ProcessEnv = {};
    const merged = mergeDotenv(env, path);
    expect(env.RPC_URL).toBeUndefined();
    expect(merged.RPC_URL).toBe('https://x.example');
  });
});

describe('secrecy', () => {
  it('describeConfig exposes the public key and never the secret', () => {
    const cfg = load({ BILLBOARD_KEYPAIR: SECRET_B58, MAX_BID_SOL: '0.25', AUTO_BID: 'true' });
    const view = JSON.stringify(describeConfig(cfg));
    expect(view).toContain(kp.publicKey.toBase58());
    expect(view).not.toContain(SECRET_B58);
    // the secret as a JSON byte array would show up as a run of numbers
    expect(view).not.toContain(Array.from(kp.secretKey.slice(0, 8)).join(','));
    expect(view).toContain('"mode":"auto"');
    expect(view).toContain('"max_bid_lamports":"250000000"');
    expect(view).toContain('"proposal_ttl_min":60');
  });

  it('every error path involving the key omits the base58 secret', () => {
    const attempts: Array<() => unknown> = [
      () => load({ BILLBOARD_KEYPAIR: SECRET_B58 }),
      () => load({ BILLBOARD_KEYPAIR: SECRET_B58, MAX_BID_SOL: 'bad' }),
      () => load({ BILLBOARD_KEYPAIR: SECRET_B58, MAX_BID_SOL: '1', AUTO_BID: 'x' }),
    ];
    for (const attempt of attempts) {
      let message = '';
      try {
        attempt();
      } catch (err) {
        message = err instanceof Error ? err.message + String(err.stack) : String(err);
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(SECRET_B58);
    }
  });

  it('CONFIG_VARS lists every documented variable', () => {
    expect([...CONFIG_VARS].sort()).toEqual(
      [
        'ACTIVITY_LOG_PATH',
        'AUTO_BID',
        'BILLBOARD_KEYPAIR',
        'DAILY_CAP_SOL',
        'HISTORY_URL',
        'INTENT_PATH',
        'MAX_BID_SOL',
        'PROPOSAL_TTL_MIN',
        'RPC_URL',
        'RPC_WS_URL',
      ].sort(),
    );
  });
});
