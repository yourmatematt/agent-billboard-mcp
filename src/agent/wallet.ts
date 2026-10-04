/**
 * The agent's wallet: a new keypair file, or an existing one checked through
 * the package's own keypair parsing (`loadKeypair` in config.ts, the same code
 * the server runs at start-up, so a file `init` accepts is a file the server
 * accepts).
 *
 * Rules:
 *   - A new wallet is a Solana CLI keypair file: a JSON array of 64 numbers.
 *     On POSIX it is created with mode 0600 and chmod-ed to 0600 again in
 *     case a umask or filesystem widened it. On Windows the mode bits mean
 *     nothing; the file inherits the folder's ACL (a user profile is private
 *     to that user by default).
 *   - A keypair file is never overwritten. Creation opens the path with the
 *     exclusive flag, so an existing file is refused by the filesystem, not by
 *     a check that could race. `--force` does not change this.
 *   - The secret never leaves this module: every function returns the path
 *     and the public key, never the `Keypair`. Nothing here prints or logs.
 *   - Errors never echo a value the operator gave unless a file exists at it:
 *     a pasted secret key in place of a path must not be repeated back.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';

import { ConfigError, loadKeypair } from '../config.js';
import { agentPlatform, type AgentPlatform } from './settings.js';

export class WalletError extends Error {
  override readonly name = 'WalletError';
  constructor(message: string) {
    super(message);
  }
}

/** What every wallet function returns. Deliberately no secret. */
export interface WalletInfo {
  /** Absolute path to the keypair file. */
  readonly path: string;
  /** The wallet's address, base58. */
  readonly publicKey: string;
}

/** The mode a new keypair file gets on POSIX: owner read and write only. */
export const KEYPAIR_FILE_MODE = 0o600;

export interface CreateWalletOptions {
  /** Directory a relative `path` resolves against. Default `process.cwd()`. */
  cwd?: string;
  /** Injected so the POSIX and Windows shapes are tested on any host. */
  platform?: AgentPlatform;
  /** Injected for tests; default `fs.chmodSync`. Only called on POSIX. */
  chmod?: (path: string, mode: number) => void;
}

/**
 * Generates a keypair and writes it to `path` in Solana CLI format. Refuses
 * when anything already exists at `path`. Returns the path and public key.
 */
export function createWallet(path: string, options: CreateWalletOptions = {}): WalletInfo {
  const target = resolve(options.cwd ?? process.cwd(), path);
  const platform = options.platform ?? agentPlatform();
  if (existsSync(target)) throw existingWalletError(target);

  mkdirSync(dirname(target), { recursive: true });
  const keypair = Keypair.generate();
  const text = `${JSON.stringify(Array.from(keypair.secretKey))}\n`;

  let fd: number;
  try {
    // 'wx': create, fail if it exists. The mode applies on POSIX only.
    fd = openSync(target, 'wx', KEYPAIR_FILE_MODE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw existingWalletError(target);
    throw new WalletError(`could not create the wallet file at ${target}: ${errorCode(err)}`);
  }
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    // This process created the file a moment ago; a half-written key is
    // worse than none, so it goes.
    rmSync(target, { force: true });
    throw new WalletError(`could not write the wallet file at ${target}: ${errorCode(err)}`);
  }
  closeSync(fd);

  if (platform === 'posix') (options.chmod ?? chmodSync)(target, KEYPAIR_FILE_MODE);
  return { path: target, publicKey: keypair.publicKey.toBase58() };
}

/**
 * Checks an existing keypair file and returns its absolute path and public
 * key. Only a file is accepted here (never a pasted base58 key: `.env` holds
 * a path, so the secret lives in one place). The file is parsed by the
 * server's own `loadKeypair`, so every format the server accepts is accepted.
 */
export function importWallet(path: string, cwd: string = process.cwd()): WalletInfo {
  const trimmed = path.trim();
  if (trimmed === '') throw new WalletError('the keypair path is empty.');
  const target = resolve(cwd, trimmed);

  let isFile: boolean;
  try {
    isFile = statSync(target).isFile();
  } catch {
    // Nothing exists there, so the value may be a secret pasted by mistake.
    // Say where it was looked for, never what was given.
    throw new WalletError(
      `no keypair file exists at the path given (resolved relative to ${cwd}). ` +
        'Give the path to a keypair file, not the key itself.',
    );
  }
  if (!isFile) throw new WalletError(`${target} is a folder, not a keypair file.`);

  return walletInfo(target);
}

/** The public key of the keypair file at `path`, checked the same way as `importWallet`. */
export function walletPublicKey(path: string, cwd: string = process.cwd()): string {
  return importWallet(path, cwd).publicKey;
}

function walletInfo(target: string): WalletInfo {
  let keypair: Keypair;
  try {
    keypair = loadKeypair(target);
  } catch (err) {
    if (err instanceof ConfigError) {
      // config.ts words its errors for the env var; the substance (format,
      // byte counts, the accepted list) is the same here.
      throw new WalletError(
        `cannot use that keypair: ${err.message.replace(/^BILLBOARD_KEYPAIR /, '')}`,
      );
    }
    throw err;
  }
  return { path: target, publicKey: keypair.publicKey.toBase58() };
}

function existingWalletError(target: string): WalletError {
  return new WalletError(
    `a wallet file already exists at ${target}. A keypair file is never overwritten, ` +
      'even with --force; use it with --keypair, or choose another folder.',
  );
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
}
