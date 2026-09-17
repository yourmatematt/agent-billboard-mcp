/**
 * Configuration: environment variables, read once at startup, validated with zod.
 *
 * Everything the server needs from the operator comes through this module.
 * SOL amounts arrive as decimal strings and leave as lamports (`bigint`).
 * The keypair, if any, is loaded here and nowhere else.
 *
 * Rules that matter:
 *   - No `BILLBOARD_KEYPAIR`  -> read-only mode. Write tools refuse cleanly.
 *   - `BILLBOARD_KEYPAIR` set -> `MAX_BID_SOL` is mandatory. Start-up fails
 *     with a message naming the variable, so a keypair can never be loaded
 *     without a spend limit beside it.
 *   - `DAILY_CAP_SOL` defaults to `MAX_BID_SOL`.
 *   - Error messages never contain the secret key, in any encoding.
 *   - Nothing here writes to stdout (that channel belongs to MCP). `.env` is
 *     read with `dotenv.parse`, not `dotenv.config`, because the latter logs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';

import { solToLamports } from './program/math.js';
import {
  DEFAULT_PROPOSAL_TTL_MIN,
  MAX_PROPOSAL_TTL_MIN,
  MIN_PROPOSAL_TTL_MIN,
} from './proposals.js';
import { deriveWsUrl } from './rpc/SolanaRpc.js';

export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
export const DEFAULT_INTENT_PATH = './intent.md';
export const DEFAULT_ACTIVITY_LOG_PATH = './billboard-activity.jsonl';

/** The env var names this module reads. Kept in one place for docs and tests. */
export const CONFIG_VARS = [
  'BILLBOARD_KEYPAIR',
  'MAX_BID_SOL',
  'DAILY_CAP_SOL',
  'AUTO_BID',
  'PROPOSAL_TTL_MIN',
  'INTENT_PATH',
  'HISTORY_URL',
  'RPC_URL',
  'RPC_WS_URL',
  'ACTIVITY_LOG_PATH',
] as const;

export type ConfigVar = (typeof CONFIG_VARS)[number];

export type ServerMode = 'read-only' | 'propose' | 'auto';

export interface Config {
  /** Loaded keypair, or null in read-only mode. Never log this object. */
  readonly keypair: Keypair | null;
  /** True when no keypair was supplied. Write tools refuse. */
  readonly readOnly: boolean;
  /** `read-only` (no keypair), `propose` (keypair, AUTO_BID=false) or `auto`. */
  readonly mode: ServerMode;
  /** Largest single bid the server will sign, in lamports. Null in read-only mode. */
  readonly maxBidLamports: bigint | null;
  /** Total gross bids per rolling 24 h, in lamports. Null in read-only mode. */
  readonly dailyCapLamports: bigint | null;
  readonly autoBid: boolean;
  /** How long a proposal stays open, in minutes. Only meaningful in propose mode. */
  readonly proposalTtlMin: number;
  /** Absolute path to intent.md. The file may not exist; that is not an error. */
  readonly intentPath: string;
  readonly historyUrl: string | null;
  readonly rpcUrl: string;
  readonly rpcWsUrl: string;
  /** Absolute path to the JSONL activity log. */
  readonly activityLogPath: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// zod schema over the raw environment
// ---------------------------------------------------------------------------

const solAmount = (name: ConfigVar) =>
  z.string().transform((value, ctx) => {
    try {
      return solToLamports(value.trim());
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: `${name} must be a SOL amount as a plain decimal string with at most 9 decimals (e.g. "0.25"): ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      return z.NEVER;
    }
  });

const boolString = (name: ConfigVar) =>
  z.string().transform((value, ctx) => {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    ctx.addIssue({ code: 'custom', message: `${name} must be "true" or "false", got "${value}"` });
    return z.NEVER;
  });

/** A whole number of minutes inside an inclusive range. */
const minutes = (name: ConfigVar, min: number, max: number) =>
  z.string().transform((value, ctx) => {
    const v = value.trim();
    if (!/^\d+$/.test(v)) {
      ctx.addIssue({
        code: 'custom',
        message: `${name} must be a whole number of minutes, got "${value}"`,
      });
      return z.NEVER;
    }
    const parsed = Number(v);
    if (parsed < min || parsed > max) {
      ctx.addIssue({
        code: 'custom',
        message: `${name} must be between ${min} and ${max} minutes, got ${parsed}`,
      });
      return z.NEVER;
    }
    return parsed;
  });

const httpUrl = (name: ConfigVar) =>
  z.string().transform((value, ctx) => {
    const v = value.trim();
    let parsed: URL;
    try {
      parsed = new URL(v);
    } catch {
      ctx.addIssue({ code: 'custom', message: `${name} must be a valid URL, got "${value}"` });
      return z.NEVER;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      ctx.addIssue({ code: 'custom', message: `${name} must use http or https, got "${value}"` });
      return z.NEVER;
    }
    return v;
  });

const wsUrl = z.string().transform((value, ctx) => {
  const v = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    ctx.addIssue({ code: 'custom', message: `RPC_WS_URL must be a valid URL, got "${value}"` });
    return z.NEVER;
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    ctx.addIssue({ code: 'custom', message: `RPC_WS_URL must use ws or wss, got "${value}"` });
    return z.NEVER;
  }
  return v;
});

const nonEmptyPath = (name: ConfigVar) =>
  z
    .string()
    .trim()
    .min(1, { message: `${name} must not be blank` });

/**
 * The raw schema. `BILLBOARD_KEYPAIR` is deliberately a plain string here;
 * it is decoded separately so its value never flows through zod's error
 * formatting (which would echo the input).
 */
const envSchema = z.object({
  BILLBOARD_KEYPAIR: z.string().optional(),
  MAX_BID_SOL: solAmount('MAX_BID_SOL').optional(),
  DAILY_CAP_SOL: solAmount('DAILY_CAP_SOL').optional(),
  AUTO_BID: boolString('AUTO_BID').default(false),
  PROPOSAL_TTL_MIN: minutes('PROPOSAL_TTL_MIN', MIN_PROPOSAL_TTL_MIN, MAX_PROPOSAL_TTL_MIN).default(
    DEFAULT_PROPOSAL_TTL_MIN,
  ),
  INTENT_PATH: nonEmptyPath('INTENT_PATH').default(DEFAULT_INTENT_PATH),
  HISTORY_URL: httpUrl('HISTORY_URL').optional(),
  RPC_URL: httpUrl('RPC_URL').default(DEFAULT_RPC_URL),
  RPC_WS_URL: wsUrl.optional(),
  ACTIVITY_LOG_PATH: nonEmptyPath('ACTIVITY_LOG_PATH').default(DEFAULT_ACTIVITY_LOG_PATH),
});

// ---------------------------------------------------------------------------
// Keypair loading
// ---------------------------------------------------------------------------

const SECRET_KEY_BYTES = 64;
const SEED_BYTES = 32;

/**
 * The three forms an agent's wallet actually arrives in. Every keypair error
 * ends with this list, so an operator who got the format wrong is told what
 * is accepted without having to open the README. It describes shapes only —
 * nothing here can echo a value.
 */
const ACCEPTED_FORMATS =
  'Accepted: (1) a base58-encoded 64-byte secret key, usually 88 characters, as a wallet exports it; ' +
  '(2) the path to a Solana CLI keypair file (a JSON array of 64 numbers); ' +
  '(3) the path to a JSON file holding that base58 secret key as a string.';

/**
 * A `ConfigError` that names the format received and the three accepted ones.
 * `received` is a phrase completing "BILLBOARD_KEYPAIR ..." and must describe
 * the value's shape, never its contents.
 */
function keypairError(received: string): ConfigError {
  return new ConfigError(`BILLBOARD_KEYPAIR ${received} ${ACCEPTED_FORMATS}`);
}

/**
 * Loads a keypair from a base58-encoded 64-byte secret key, or from the path
 * to a keypair file holding either a Solana CLI byte array or that same
 * base58 secret key as a JSON string.
 *
 * A value is treated as a path when a file exists at it (relative to `cwd`)
 * or when it ends in `.json`. Otherwise it is decoded as base58.
 *
 * Errors never include the supplied value: the value may be the secret.
 */
export function loadKeypair(value: string, cwd: string = process.cwd()): Keypair {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw keypairError('is set but empty.');
  }

  const asPath = resolve(cwd, trimmed);
  const looksLikePath = trimmed.toLowerCase().endsWith('.json') || existsSync(asPath);

  if (looksLikePath) {
    return loadKeypairFile(asPath);
  }
  return loadKeypairBase58(trimmed);
}

function loadKeypairFile(path: string): Keypair {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    // A path is only echoed when something exists at it. When nothing does,
    // the "path" is the operator's raw value, which may be a secret key that
    // happened to end in `.json`; say where it was looked for instead.
    if (code === 'ENOENT') {
      throw keypairError(
        `looks like a keypair file path but no file exists there ` +
          `(resolved relative to ${dirname(path)}).`,
      );
    }
    throw keypairError(`points to a keypair file that could not be read (${code}): ${path}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Some runtimes write the base58 secret key to a file without quoting it,
    // which is not JSON. Treat the whole file as the key before giving up.
    return decodeBase58Secret(
      raw.trim(),
      `keypair file is not valid JSON and its contents are not a base58 secret key either: ${path}.`,
      `keypair file ${path}`,
    );
  }

  // Form (3): a JSON string holding the base58 secret key.
  if (typeof parsed === 'string') {
    return decodeBase58Secret(
      parsed.trim(),
      `keypair file holds a JSON string that is not valid base58: ${path}.`,
      `keypair file ${path}`,
    );
  }

  // Form (2): the Solana CLI byte array.
  const bytes = z.array(z.number().int().min(0).max(255)).safeParse(parsed);
  if (!bytes.success || bytes.data.length !== SECRET_KEY_BYTES) {
    const got = Array.isArray(parsed)
      ? `an array of ${parsed.length} entries`
      : `JSON of type ${parsed === null ? 'null' : typeof parsed}`;
    throw keypairError(
      `keypair file must be a JSON array of exactly ${SECRET_KEY_BYTES} byte values ` +
        `(Solana CLI format) or a JSON string holding a base58 secret key; ${path} holds ${got}.`,
    );
  }
  return fromSecretKey(Uint8Array.from(bytes.data), `keypair file ${path}`);
}

function loadKeypairBase58(value: string): Keypair {
  return decodeBase58Secret(
    value,
    'is neither an existing keypair file path nor a valid base58 string.',
    'base58 value',
  );
}

/**
 * Decodes a base58 secret key and checks its length. `undecodable` is the
 * phrase used when base58 decoding fails; `source` names where the bytes came
 * from. Neither may contain the value.
 */
function decodeBase58Secret(value: string, undecodable: string, source: string): Keypair {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw keypairError(undecodable);
  }
  if (decoded.length === SEED_BYTES) {
    // 32 bytes is either a seed or a public key. We cannot tell which, and it
    // does not matter: neither can sign.
    throw keypairError(
      `${source} decodes to ${SEED_BYTES} bytes, which is a private key seed or a public key, ` +
        `not a ${SECRET_KEY_BYTES}-byte secret key. The server signs transactions, so it needs the ` +
        'full keypair: export it from your wallet, or run `solana-keygen` against the seed.',
    );
  }
  if (decoded.length !== SECRET_KEY_BYTES) {
    throw keypairError(
      `${source} decodes to ${decoded.length} bytes; a Solana secret key is ${SECRET_KEY_BYTES} bytes.`,
    );
  }
  return fromSecretKey(decoded, source);
}

function fromSecretKey(bytes: Uint8Array, source: string): Keypair {
  try {
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new ConfigError(`BILLBOARD_KEYPAIR ${source} is not a valid ed25519 secret key`);
  }
}

// ---------------------------------------------------------------------------
// .env and loadConfig
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** Directory relative paths resolve against. Default `process.cwd()`. */
  cwd?: string;
  /**
   * Path of a dotenv file to merge in. Default `<cwd>/.env`. A missing file is
   * fine. Real environment variables always win over the file. Pass `null`
   * to skip dotenv entirely.
   */
  dotenvPath?: string | null;
}

/**
 * Reads a dotenv file if it exists and returns `env` with the file's values
 * filled in wherever `env` has no value. Never touches `process.env`.
 */
export function mergeDotenv(env: NodeJS.ProcessEnv, dotenvPath: string): NodeJS.ProcessEnv {
  if (!existsSync(dotenvPath)) return env;
  let parsed: Record<string, string>;
  try {
    parsed = parseDotenv(readFileSync(dotenvPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      `could not read ${dotenvPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(parsed)) {
    if (merged[key] === undefined || merged[key] === '') merged[key] = value;
  }
  return merged;
}

/** Picks the variables we care about and treats blank strings as unset. */
function pickEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of CONFIG_VARS) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') picked[name] = value;
  }
  return picked;
}

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.length > 0 ? String(issue.path[0]) : 'config';
    // Our transforms already prefix messages with the variable name.
    return issue.message.startsWith(name)
      ? `  - ${issue.message}`
      : `  - ${name}: ${issue.message}`;
  });
  return `invalid configuration:\n${lines.join('\n')}`;
}

/**
 * Builds the server configuration from environment variables.
 *
 * Reads `env` (default `process.env`), merges `.env` from `cwd` if present,
 * validates every variable, loads the keypair, and derives mode and limits.
 * Throws `ConfigError` with an operator-readable message on any problem.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): Config {
  const cwd = options.cwd ?? process.cwd();
  const dotenvPath = options.dotenvPath === undefined ? resolve(cwd, '.env') : options.dotenvPath;
  const merged = dotenvPath === null ? env : mergeDotenv(env, dotenvPath);

  const result = envSchema.safeParse(pickEnv(merged));
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error));
  }
  const raw = result.data;

  // Keypair and limits. A keypair without a spend limit is refused at start-up.
  let keypair: Keypair | null = null;
  let maxBidLamports: bigint | null = null;
  let dailyCapLamports: bigint | null = null;

  if (raw.BILLBOARD_KEYPAIR !== undefined) {
    if (raw.MAX_BID_SOL === undefined) {
      throw new ConfigError(
        'BILLBOARD_KEYPAIR is set but MAX_BID_SOL is not. ' +
          'A keypair is never loaded without a spend limit. ' +
          'Set MAX_BID_SOL to the largest single bid in SOL you will allow (e.g. MAX_BID_SOL=0.2), ' +
          'or unset BILLBOARD_KEYPAIR to run read-only.',
      );
    }
    keypair = loadKeypair(raw.BILLBOARD_KEYPAIR, cwd);
    maxBidLamports = raw.MAX_BID_SOL;
    dailyCapLamports = raw.DAILY_CAP_SOL ?? raw.MAX_BID_SOL;
  }

  const readOnly = keypair === null;
  const mode: ServerMode = readOnly ? 'read-only' : raw.AUTO_BID ? 'auto' : 'propose';

  return {
    keypair,
    readOnly,
    mode,
    maxBidLamports,
    dailyCapLamports,
    autoBid: raw.AUTO_BID,
    proposalTtlMin: raw.PROPOSAL_TTL_MIN,
    intentPath: resolve(cwd, raw.INTENT_PATH),
    historyUrl: raw.HISTORY_URL ?? null,
    rpcUrl: raw.RPC_URL,
    rpcWsUrl: raw.RPC_WS_URL ?? deriveWsUrl(raw.RPC_URL),
    activityLogPath: resolve(cwd, raw.ACTIVITY_LOG_PATH),
  };
}

/**
 * A loggable view of the config: everything except the keypair, with the
 * wallet public key in its place and SOL figures as decimal strings.
 */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    mode: config.mode,
    wallet: config.keypair ? config.keypair.publicKey.toBase58() : null,
    max_bid_lamports: config.maxBidLamports?.toString() ?? null,
    daily_cap_lamports: config.dailyCapLamports?.toString() ?? null,
    auto_bid: config.autoBid,
    proposal_ttl_min: config.proposalTtlMin,
    intent_path: config.intentPath,
    history_url: config.historyUrl,
    rpc_url: config.rpcUrl,
    rpc_ws_url: config.rpcWsUrl,
    activity_log_path: config.activityLogPath,
  };
}
