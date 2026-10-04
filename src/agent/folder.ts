/**
 * The agent folder: where every file lives, and how the plain ones are read
 * and written. `init` writes the folder, `run` and `report` read it.
 *
 *   intent.md              the operator's brief (rendered by intent-template.ts)
 *   .env                   BILLBOARD_KEYPAIR, MAX_BID_SOL, DAILY_CAP_SOL, AUTO_BID, INTENT_PATH
 *   wallet.keypair.json    only with a new wallet; never printed, never overwritten
 *   agent.json             runner settings (schema and defaults below)
 *   .mcp.json              Claude Code project config (settings.ts)
 *   .claude/settings.json  the tool lock (settings.ts)
 *   .gitignore             keeps secrets and logs out of a repo
 *
 * Rules:
 *   - `.env` is rewritten line by line: the keys being set are replaced in
 *     place, every other line (unknown keys, comments) is kept as it was, and
 *     new keys are appended. Values are quoted only when they need it, and
 *     never in double quotes when they hold a backslash, because dotenv
 *     expands `\n` inside double quotes and a Windows path is full of them.
 *   - `agent.json` is strict: an unknown key is an error naming it, so a
 *     typo never silently leaves a default in force.
 *   - Writes are atomic (a temp file beside the target, then a rename).
 *   - Nothing here reads the keypair file or prints anything.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';

import { DEFAULT_INTENT_PATH, DEFAULT_RPC_URL } from '../config.js';
import { toJsonFile } from './settings.js';

export class AgentFolderError extends Error {
  override readonly name = 'AgentFolderError';
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** File names inside an agent folder, relative to it. */
export const AGENT_FILES = {
  intent: 'intent.md',
  env: '.env',
  keypair: 'wallet.keypair.json',
  agentJson: 'agent.json',
  mcpJson: '.mcp.json',
  mcpSandboxJson: '.mcp.sandbox.json',
  claudeDir: '.claude',
  settings: join('.claude', 'settings.json'),
  gitignore: '.gitignore',
  runnerState: 'runner-state.json',
  logs: 'logs',
  runnerLog: join('logs', 'runner.log'),
  wakeLog: join('logs', 'wake.log'),
  wakes: join('logs', 'wakes'),
  pause: 'PAUSE',
  activityLog: 'billboard-activity.jsonl',
  sandboxActivityLog: 'billboard-sandbox-activity.jsonl',
} as const;

export type AgentPaths = { readonly dir: string } & {
  readonly [K in keyof typeof AGENT_FILES]: string;
};

/** Absolute paths for every file in the folder at `dir` (resolved against `cwd`). */
export function agentPaths(dir: string, cwd: string = process.cwd()): AgentPaths {
  const root = resolve(cwd, dir);
  const paths: Record<string, string> = { dir: root };
  for (const [key, rel] of Object.entries(AGENT_FILES)) paths[key] = join(root, rel);
  return paths as AgentPaths;
}

/** Writes `text` to `path` through a temp file and a rename. Creates the parent folder. */
export function writeFileAtomic(path: string, text: string, options: { mode?: number } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, options.mode === undefined ? 'utf8' : { mode: options.mode });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// agent.json
// ---------------------------------------------------------------------------

/**
 * Runner defaults, from round-two evidence: the fleet's 5-30 minute reactions
 * spent the board's whole price range in under three hours, so reactions are
 * slower and wakes rarer here.
 */
export const AGENT_SETTINGS_DEFAULTS = {
  model: null as string | null,
  react_min_min: 10,
  react_max_min: 60,
  min_gap_min: 30,
  max_wakes_24h: 6,
  next_look_min_h: 1,
  next_look_max_h: 24,
  first_wake_max_min: 5,
  max_turns: 12,
  wake_timeout_min: 10,
  poll_min_s: 60,
  poll_max_s: 180,
  rpc_url: DEFAULT_RPC_URL,
};

const positive = z.number().positive();
const wholePositive = z.number().int().positive();

const httpUrl = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  },
  { message: 'must be an http or https URL' },
);

const D = AGENT_SETTINGS_DEFAULTS;

export const agentSettingsSchema = z
  .object({
    model: z
      .string()
      .trim()
      .min(1, { message: 'must be a model id or null' })
      .nullable()
      .default(D.model),
    react_min_min: positive.default(D.react_min_min),
    react_max_min: positive.default(D.react_max_min),
    min_gap_min: z.number().nonnegative().default(D.min_gap_min),
    max_wakes_24h: wholePositive.default(D.max_wakes_24h),
    next_look_min_h: positive.default(D.next_look_min_h),
    next_look_max_h: positive.default(D.next_look_max_h),
    first_wake_max_min: z.number().nonnegative().default(D.first_wake_max_min),
    max_turns: wholePositive.default(D.max_turns),
    wake_timeout_min: positive.default(D.wake_timeout_min),
    poll_min_s: positive.default(D.poll_min_s),
    poll_max_s: positive.default(D.poll_max_s),
    rpc_url: httpUrl.default(D.rpc_url),
  })
  .strict()
  .superRefine((s, ctx) => {
    const pairs = [
      ['react_min_min', 'react_max_min'],
      ['next_look_min_h', 'next_look_max_h'],
      ['poll_min_s', 'poll_max_s'],
    ] as const;
    for (const [lo, hi] of pairs) {
      if (s[lo] > s[hi]) {
        ctx.addIssue({ code: 'custom', path: [lo], message: `must not be above ${hi}` });
      }
    }
  });

export type AgentSettings = z.output<typeof agentSettingsSchema>;

function formatSettingsIssues(path: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return `  - unknown setting${issue.keys.length > 1 ? 's' : ''}: ${issue.keys.join(', ')}`;
    }
    const key = issue.path.length > 0 ? String(issue.path[0]) : 'agent.json';
    return `  - ${key}: ${issue.message}`;
  });
  return `invalid ${path}:\n${lines.join('\n')}`;
}

/** Validates a parsed `agent.json` value. Missing keys take their defaults. */
export function parseAgentSettings(value: unknown, path = 'agent.json'): AgentSettings {
  const result = agentSettingsSchema.safeParse(value);
  if (!result.success) throw new AgentFolderError(formatSettingsIssues(path, result.error));
  return result.data;
}

/** Reads `agent.json`. A missing file means every default. */
export function readAgentSettings(path: string): AgentSettings {
  if (!existsSync(path)) return parseAgentSettings({}, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new AgentFolderError(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseAgentSettings(parsed, path);
}

/** The text of an `agent.json` holding every setting, defaults filled in. */
export function agentSettingsFile(overrides: Partial<AgentSettings> = {}): string {
  const settings = parseAgentSettings({ ...AGENT_SETTINGS_DEFAULTS, ...overrides });
  return toJsonFile(settings);
}

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

/** The keys `init` writes, in the order a fresh `.env` lists them. */
export const AGENT_ENV_KEYS = [
  'BILLBOARD_KEYPAIR',
  'MAX_BID_SOL',
  'DAILY_CAP_SOL',
  'AUTO_BID',
  'INTENT_PATH',
] as const;

export type AgentEnvKey = (typeof AGENT_ENV_KEYS)[number];

export interface AgentEnvInput {
  /** Absolute path to the keypair file. Never the key itself. */
  keypairPath: string;
  maxBidSol: string;
  dailyCapSol: string;
  autoBid: boolean;
}

/** The values `init` sets in `.env`. */
export function agentEnvValues(input: AgentEnvInput): Record<AgentEnvKey, string> {
  return {
    BILLBOARD_KEYPAIR: input.keypairPath,
    MAX_BID_SOL: input.maxBidSol,
    DAILY_CAP_SOL: input.dailyCapSol,
    AUTO_BID: input.autoBid ? 'true' : 'false',
    INTENT_PATH: DEFAULT_INTENT_PATH,
  };
}

const ENV_HEADER = [
  '# agent-billboard-mcp agent settings. The server and `run` read this file.',
  '# Never commit or share it.',
];

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PLAIN_VALUE = /^[A-Za-z0-9_./:@+,=-]*$/;

/**
 * One dotenv value, quoted only when needed. Single quotes are literal in
 * dotenv, so they carry anything without a single quote (backslashes
 * included). Throws on a newline, which no value written here should hold.
 */
export function formatEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new AgentFolderError('a .env value cannot contain a newline');
  if (PLAIN_VALUE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`;
  if (!value.includes('`')) return `\`${value}\``;
  throw new AgentFolderError('a .env value cannot hold all three quote characters');
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;

/**
 * How many lines an assignment spans. A value that opens a quote and does not
 * close it on the same line runs on until the line that does (dotenv allows
 * multi-line quoted values), so replacing it must drop those lines too.
 */
function assignmentSpan(lines: readonly string[], start: number, value: string): number {
  const quote = value[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') return 1;
  if (value.indexOf(quote, 1) !== -1) return 1;
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').includes(quote)) return i - start + 1;
  }
  return 1;
}

/**
 * Sets `updates` in a dotenv text and returns the new text. Each key is
 * replaced where it first appears (later duplicates are dropped, so the file
 * cannot disagree with itself); every other line is kept; keys not present
 * are appended in the order given. `existing` null means a fresh file.
 */
export function updateEnvText(existing: string | null, updates: Record<string, string>): string {
  for (const key of Object.keys(updates)) {
    if (!ENV_KEY.test(key)) throw new AgentFolderError(`not a valid .env key: ${key}`);
  }
  const formatted = new Map(Object.entries(updates).map(([k, v]) => [k, formatEnvValue(v)]));
  const written = new Set<string>();
  const out: string[] = [];

  if (existing === null) {
    out.push(...ENV_HEADER);
  } else {
    const lines = existing.replace(/\r\n/g, '\n').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const match = line.match(ASSIGNMENT);
      const key = match?.[1];
      if (key === undefined || !formatted.has(key)) {
        out.push(line);
        continue;
      }
      i += assignmentSpan(lines, i, (match?.[2] ?? '').trim()) - 1;
      if (written.has(key)) continue;
      out.push(`${key}=${formatted.get(key)}`);
      written.add(key);
    }
  }
  for (const [key, value] of formatted) {
    if (!written.has(key)) out.push(`${key}=${value}`);
  }
  return `${out.join('\n')}\n`;
}

/** Reads a `.env` file into key/value pairs. A missing file is empty. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new AgentFolderError(
      `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Sets `updates` in the `.env` at `path`, keeping every other line. */
export function writeEnvFile(path: string, updates: Record<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  writeFileAtomic(path, updateEnvText(existing, updates));
}

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

/** What an agent folder keeps out of git: secrets, spend logs, state and runner logs. */
export const AGENT_GITIGNORE_LINES = [
  '.env',
  '*.keypair.json',
  '*.jsonl',
  'billboard-state.json',
  'runner-state.json',
  'logs/',
] as const;

/** Returns `existing` with any missing agent lines appended, or a fresh file. */
export function updateGitignoreText(existing: string | null): string {
  const base = existing === null ? '' : existing.replace(/\r\n/g, '\n');
  const head = base === '' || base.endsWith('\n') ? base : `${base}\n`;
  const present = new Set(head.split('\n').map((line) => line.trim()));
  const missing = AGENT_GITIGNORE_LINES.filter((line) => !present.has(line));
  return missing.length === 0 ? head : `${head}${missing.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// CLAUDE.md check
// ---------------------------------------------------------------------------

/** The files Claude Code loads as project memory from a folder and its ancestors. */
const CLAUDE_MD_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', join('.claude', 'CLAUDE.md')] as const;

/**
 * Every CLAUDE.md that Claude Code would load into a wake started in `dir`:
 * in `dir` itself and in each ancestor up to the root, nearest first. `dir`
 * need not exist yet. `exists` is injectable for tests.
 */
export function findClaudeMdFiles(
  dir: string,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const found: string[] = [];
  let current = resolve(dir);
  for (;;) {
    for (const name of CLAUDE_MD_NAMES) {
      const candidate = join(current, name);
      if (exists(candidate)) found.push(candidate);
    }
    const parent = dirname(current);
    if (parent === current) return found;
    current = parent;
  }
}

/** The warning `init` prints for each file `findClaudeMdFiles` returns. */
export function claudeMdWarning(path: string): string {
  return `A CLAUDE.md at ${path} would be loaded into your agent's context. Move the folder or remove that file.`;
}
