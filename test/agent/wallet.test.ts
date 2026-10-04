import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KEYPAIR_FILE_MODE,
  WalletError,
  createWallet,
  importWallet,
  walletPublicKey,
} from '../../src/agent/wallet.js';
import { loadKeypair } from '../../src/config.js';
import { captureAll } from './capture.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-wallet-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Every encoding a 64-byte secret (or its 32-byte seed) could leak in. */
function secretEncodings(secret: Uint8Array): string[] {
  const bytes = Array.from(secret);
  const seed = secret.slice(0, 32);
  return [
    JSON.stringify(bytes),
    bytes.join(', '),
    bytes.join(','),
    bs58.encode(secret),
    bs58.encode(seed),
    Buffer.from(secret).toString('hex'),
    Buffer.from(secret).toString('base64'),
    Buffer.from(seed).toString('hex'),
    Buffer.from(seed).toString('base64'),
  ];
}

function readSecret(path: string): Uint8Array {
  return Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
}

describe('createWallet', () => {
  it('writes a Solana CLI keypair file the server itself can load', () => {
    const info = createWallet('wallet.keypair.json', {
      cwd: dir,
      platform: 'posix',
      chmod: () => {},
    });
    expect(info.path).toBe(join(dir, 'wallet.keypair.json'));

    const parsed = JSON.parse(readFileSync(info.path, 'utf8')) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(64);
    for (const n of parsed as unknown[]) {
      expect(Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 255).toBe(true);
    }
    expect(loadKeypair(info.path).publicKey.toBase58()).toBe(info.publicKey);
  });

  it('returns only the path and the public key, never the secret', () => {
    const info = createWallet(join(dir, 'w.keypair.json'), { platform: 'win32' });
    expect(Object.keys(info).sort()).toEqual(['path', 'publicKey']);
    const secret = readSecret(info.path);
    const serialised = JSON.stringify(info);
    for (const enc of secretEncodings(secret)) expect(serialised).not.toContain(enc);
  });

  it('makes a fresh keypair every time', () => {
    const a = createWallet(join(dir, 'a.keypair.json'), { platform: 'win32' });
    const b = createWallet(join(dir, 'b.keypair.json'), { platform: 'win32' });
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('creates the parent folder when it does not exist yet', () => {
    const info = createWallet(join(dir, 'new', 'agent', 'wallet.keypair.json'), {
      platform: 'win32',
    });
    expect(existsSync(info.path)).toBe(true);
  });

  it('on POSIX, sets the file to 0600', () => {
    const chmod = vi.fn();
    const info = createWallet(join(dir, 'w.keypair.json'), { platform: 'posix', chmod });
    expect(KEYPAIR_FILE_MODE).toBe(0o600);
    expect(chmod).toHaveBeenCalledTimes(1);
    expect(chmod).toHaveBeenCalledWith(info.path, 0o600);
  });

  it('on Windows, leaves permissions to the folder ACL', () => {
    const chmod = vi.fn();
    createWallet(join(dir, 'w.keypair.json'), { platform: 'win32', chmod });
    expect(chmod).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('really is 0600 on a POSIX filesystem', () => {
    const info = createWallet(join(dir, 'w.keypair.json'));
    expect(statSync(info.path).mode & 0o777).toBe(0o600);
  });

  it('never overwrites an existing keypair file, and leaves it byte for byte', () => {
    const first = createWallet(join(dir, 'wallet.keypair.json'), { platform: 'win32' });
    const before = readFileSync(first.path, 'utf8');
    expect(() => createWallet(first.path, { platform: 'win32' })).toThrow(WalletError);
    expect(() => createWallet(first.path, { platform: 'win32' })).toThrow(
      /already exists .* never overwritten, even with --force/,
    );
    expect(readFileSync(first.path, 'utf8')).toBe(before);
    // No temp or partial file left beside it.
    expect(readdirSync(dir)).toEqual(['wallet.keypair.json']);
  });

  it('refuses whatever sits at the path, not only a keypair', () => {
    const path = join(dir, 'wallet.keypair.json');
    writeFileSync(path, 'operator notes');
    expect(() => createWallet(path, { platform: 'win32' })).toThrow(/already exists/);
    expect(readFileSync(path, 'utf8')).toBe('operator notes');
  });
});

describe('importWallet', () => {
  const kp = Keypair.generate();

  it('accepts a Solana CLI keypair file and returns its absolute path and public key', () => {
    writeFileSync(join(dir, 'mine.json'), JSON.stringify(Array.from(kp.secretKey)));
    const info = importWallet('mine.json', dir);
    expect(info).toEqual({ path: join(dir, 'mine.json'), publicKey: kp.publicKey.toBase58() });
  });

  it('accepts every file format the server accepts', () => {
    // A JSON string holding the base58 secret, and the same unquoted.
    writeFileSync(join(dir, 'quoted.json'), JSON.stringify(bs58.encode(kp.secretKey)));
    writeFileSync(join(dir, 'bare.txt'), `${bs58.encode(kp.secretKey)}\n`);
    expect(importWallet('quoted.json', dir).publicKey).toBe(kp.publicKey.toBase58());
    expect(importWallet('bare.txt', dir).publicKey).toBe(kp.publicKey.toBase58());
  });

  it('round-trips a wallet createWallet wrote', () => {
    const created = createWallet(join(dir, 'w.keypair.json'), { platform: 'win32' });
    expect(importWallet(created.path)).toEqual(created);
    expect(walletPublicKey(created.path)).toBe(created.publicKey);
  });

  it('refuses a missing file without echoing what was given', () => {
    const err = (() => {
      try {
        importWallet('nope.json', dir);
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected a throw');
    })();
    expect(err).toBeInstanceOf(WalletError);
    expect(err.message).toMatch(/no keypair file exists at the path given/);
    expect(err.message).not.toContain('nope.json');
  });

  it('refuses a folder', () => {
    mkdirSync(join(dir, 'sub'));
    expect(() => importWallet('sub', dir)).toThrow(/is a folder, not a keypair file/);
  });

  it('refuses an empty path', () => {
    expect(() => importWallet('  ', dir)).toThrow(/keypair path is empty/);
  });

  it('refuses a 32-byte seed and a short array, with the server’s reasons', () => {
    writeFileSync(join(dir, 'seed.json'), JSON.stringify(Array.from(kp.secretKey.slice(0, 32))));
    expect(() => importWallet('seed.json', dir)).toThrow(
      /cannot use that keypair: keypair file must be a JSON array of exactly 64/,
    );
    writeFileSync(
      join(dir, 'b58seed.json'),
      JSON.stringify(bs58.encode(kp.secretKey.slice(0, 32))),
    );
    expect(() => importWallet('b58seed.json', dir)).toThrow(/decodes to 32 bytes/);
    // The env var name from config.ts is not carried into an import error.
    expect(() => importWallet('seed.json', dir)).toThrow(/^(?!.*BILLBOARD_KEYPAIR)/);
  });
});

describe('the secret never reaches the output', () => {
  it('create, import and every refusal print nothing that holds the key, in any encoding', async () => {
    const other = Keypair.generate();
    writeFileSync(join(dir, 'other.json'), JSON.stringify(Array.from(other.secretKey)));
    writeFileSync(
      join(dir, 'other-seed.json'),
      JSON.stringify(Array.from(other.secretKey.slice(0, 32))),
    );
    let created = '';

    const output = await captureAll(async () => {
      const results: unknown[] = [];
      const info = createWallet(join(dir, 'wallet.keypair.json'), { platform: 'win32' });
      created = info.path;
      results.push(info, importWallet(info.path), importWallet('other.json', dir));
      results.push(walletPublicKey(info.path));
      // Every refusal, its message printed the way init will print it.
      const attempts: Array<() => unknown> = [
        () => createWallet(info.path, { platform: 'win32' }),
        () => importWallet('other-seed.json', dir),
        // The operator pastes the secret itself where a path was asked for.
        () => importWallet(bs58.encode(other.secretKey), dir),
        () => importWallet(`${bs58.encode(other.secretKey)}.json`, dir),
        () => importWallet(JSON.stringify(Array.from(other.secretKey)), dir),
      ];
      for (const attempt of attempts) {
        try {
          results.push(attempt());
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n${(err as Error).stack ?? ''}\n`);
        }
      }
      // Whatever init would show of the results.
      process.stdout.write(`${JSON.stringify(results)}\n`);
      console.log(results);
    });

    expect(output).toContain('already exists');
    expect(output).toContain('no keypair file exists at the path given');
    const secrets = [...secretEncodings(readSecret(created)), ...secretEncodings(other.secretKey)];
    for (const enc of secrets) expect(output).not.toContain(enc);
  });
});
