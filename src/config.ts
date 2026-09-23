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
 *   - `BILLBOARD_SANDBOX=true` -> rehearsal mode: an ephemeral keypair is
 *     generated here, `BILLBOARD_KEYPAIR` is never read, the RPC variables and
 *     `ACTIVITY_LOG_PATH` and `STATE_PATH` are ignored with a warning each, and the limits
 *     default so the sandbox needs no configuration at all.
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
/** Where rehearsal entries go. Never the file that records real spending. */
export const DEFAULT_SANDBOX_ACTIVITY_LOG_PATH = './billboard-sandbox-activity.jsonl';
/** Where the reader remembers what the agent last saw, between processes. */
export const DEFAULT_STATE_PATH = './billboard-state.json';
/** `MAX_BID_SOL` when the sandbox is on and the operator set none. */
export const DEFAULT_SANDBOX_MAX_BID_SOL = '1';

/** The seeded boards the sandbox can start from. */
export const SANDBOX_SCENARIOS = ['default', 'adversarial', 'idle'] as const;
export type SandboxScenario = (typeof SANDBOX_SCENARIOS)[number];
export const DEFAULT_SANDBOX_SCENARIO: SandboxScenario = 'default';

/** The env var names this module reads. Kept in one place for docs and tests. */
export const CONFIG_VARS = [
  'BILLBOARD_SANDBOX',
  'BILLBOARD_SANDBOX_SCENARIO',
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
  'STATE_PATH',
] as const;

export type ConfigVar = (typeof CONFIG_VARS)[number];

export type ServerMode = 'read-only' | 'propose' | 'auto';

export interface Config {
  /**
   * True when `BILLBOARD_SANDBOX` is on: a simulated board, an ephemeral
   * wallet, no network and no SOL. Rehearsal, never the real board.
   */
  readonly sandbox: boolean;
  /** Which seeded board the sandbox starts from. Only meaningful in sandbox. */
  readonly sandboxScenario: SandboxScenario;
  /**
   * Start-up notes for the operator, one line each: variables that were
   * ignored, and why. Printed to stderr by the CLI. Never holds a secret.
   */
  readonly warnings: readonly string[];
  /** Loaded keypair, or null in read-only mode. Never log this object. */
  readonly keypair: Keypair | null;
  /** True when no keypair was supplied. Write tools refuse. */
  readonly readOnly: boolean;
  /**
   * `read-only` (no keypair), `propose` (keypair, AUTO_BID=false) or `auto`.
   * The sandbox honours `AUTO_BID` and so is one of the latter two; read it
   * through `modeLabel` when an operator is going to see it.
   */
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
  /**
   * Absolute path to the reader state file, or null in the sandbox, whose
   * simulated board resets every start and so never persists.
   */
  readonly statePath: string | null;
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

/**
 * The sandbox switch. Only `true`, `1`, `false` and `0` are accepted, so a
 * typo can never be read as "off" and quietly put an agent on the real board.
 */
const SANDBOX_BOOL_VALUES = '"true", "1", "false" or "0"';

function parseSandboxFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new ConfigError(
    `BILLBOARD_SANDBOX must be one of ${SANDBOX_BOOL_VALUES} (case-insensitive), got "${value}". ` +
      'It is left unset for the real board.',
  );
}

const sandboxScenarioString = z.string().transform((value, ctx) => {
  const v = value.trim().toLowerCase();
  if ((SANDBOX_SCENARIOS as readonly string[]).includes(v)) return v as SandboxScenario;
  ctx.addIssue({
    code: 'custom',
    message: `BILLBOARD_SANDBOX_SCENARIO must be one of ${SANDBOX_SCENARIOS.join(', ')}, got "${value}"`,
  });
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
  // BILLBOARD_SANDBOX is parsed before the schema runs (it decides which of
  // the other variables are read at all), and repeated here so an unknown
  // value is caught wherever the schema is used on its own.
  BILLBOARD_SANDBOX: z.string().optional(),
  BILLBOARD_SANDBOX_SCENARIO: sandboxScenarioString.default(DEFAULT_SANDBOX_SCENARIO),
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
  STATE_PATH: nonEmptyPath('STATE_PATH').default(DEFAULT_STATE_PATH),
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

/**
 * The variables the sandbox ignores, and the one line each gets in the
 * warnings. They are dropped before validation, so `BILLBOARD_KEYPAIR` never
 * reaches the loader and an RPC URL the sandbox will not dial never has to
 * parse. None of these lines can hold a value the operator supplied.
 */
const SANDBOX_IGNORED: ReadonlyArray<readonly [ConfigVar, string]> = [
  [
    'BILLBOARD_KEYPAIR',
    'BILLBOARD_SANDBOX is on, so BILLBOARD_KEYPAIR is ignored and never loaded. ' +
      'The sandbox generates a fresh ephemeral keypair at start-up; a real key does not enter a simulation.',
  ],
  ['RPC_URL', 'BILLBOARD_SANDBOX is on, so RPC_URL is ignored. The sandbox makes no network call.'],
  [
    'RPC_WS_URL',
    'BILLBOARD_SANDBOX is on, so RPC_WS_URL is ignored. The sandbox opens no subscription.',
  ],
  [
    'ACTIVITY_LOG_PATH',
    `BILLBOARD_SANDBOX is on, so ACTIVITY_LOG_PATH is ignored. Rehearsal entries go to ${DEFAULT_SANDBOX_ACTIVITY_LOG_PATH}, ` +
      'never to the file that records real spending.',
  ],
  [
    'STATE_PATH',
    'BILLBOARD_SANDBOX is on, so STATE_PATH is ignored. The simulated board resets every start, ' +
      'so the sandbox keeps reader state in memory and writes no state file.',
  ],
];

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

  const picked = pickEnv(merged);

  // The sandbox switch is read first: it decides which of the other variables
  // are validated at all. An unknown value stops start-up here, because a
  // typo must never be read as "off".
  const sandbox = parseSandboxFlag(picked.BILLBOARD_SANDBOX);
  const warnings: string[] = [];
  if (sandbox) {
    for (const [name, warning] of SANDBOX_IGNORED) {
      if (picked[name] !== undefined) warnings.push(warning);
      delete picked[name];
    }
    // Zero configuration: the sandbox has a wallet, so it needs a limit.
    if (picked.MAX_BID_SOL === undefined) picked.MAX_BID_SOL = DEFAULT_SANDBOX_MAX_BID_SOL;
  }

  const result = envSchema.safeParse(picked);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error));
  }
  const raw = result.data;

  // Keypair and limits. A keypair without a spend limit is refused at start-up.
  let keypair: Keypair | null = null;
  let maxBidLamports: bigint | null = null;
  let dailyCapLamports: bigint | null = null;

  if (sandbox) {
    // Ephemeral, generated here, gone when the process exits. Nothing it
    // signs leaves the process, so it never needs funding.
    keypair = Keypair.generate();
    maxBidLamports = raw.MAX_BID_SOL ?? solToLamports(DEFAULT_SANDBOX_MAX_BID_SOL);
    dailyCapLamports = raw.DAILY_CAP_SOL ?? maxBidLamports;
  } else if (raw.BILLBOARD_KEYPAIR !== undefined) {
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
    sandbox,
    sandboxScenario: raw.BILLBOARD_SANDBOX_SCENARIO,
    warnings,
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
    activityLogPath: resolve(
      cwd,
      sandbox ? DEFAULT_SANDBOX_ACTIVITY_LOG_PATH : raw.ACTIVITY_LOG_PATH,
    ),
    statePath: sandbox ? null : resolve(cwd, raw.STATE_PATH),
  };
}

/**
 * The mode as an operator reads it. In the sandbox there is always a keypair,
 * so the label is `sandbox (propose)` or `sandbox (auto)` — never a bare
 * `propose` or `auto` that could be mistaken for the real board.
 */
export function modeLabel(config: Pick<Config, 'mode' | 'sandbox'>): string {
  return config.sandbox ? `sandbox (${config.mode})` : config.mode;
}

/**
 * A loggable view of the config: everything except the keypair, with the
 * wallet public key in its place and SOL figures as decimal strings.
 */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    mode: modeLabel(config),
    sandbox: config.sandbox,
    sandbox_scenario: config.sandbox ? config.sandboxScenario : null,
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
    state_path: config.statePath,
  };
}
