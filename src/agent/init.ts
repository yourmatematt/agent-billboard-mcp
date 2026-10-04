/**
 * `agent-billboard-mcp init [dir]`: four questions, a wallet, every file in
 * the agent folder, a sandbox rehearsal, and the address to fund.
 *
 * Order of work:
 *   1. Refuse, before anything is asked, when the folder already holds an
 *      agent and `--force` was not given.
 *   2. Work out what still needs an answer. Nothing is asked unless stdin is
 *      a terminal and `--yes` was not given; then a missing answer is an error
 *      naming the flag. Flag values are checked before any network call.
 *   3. Read the live board (read-only, 10 s timeout) while the first question
 *      is answered. Offline or on any error, setup carries on without it.
 *   4. The four questions, in the locked order and wording, then the wallet.
 *   5. The CLAUDE.md warning, the files, the rehearsal, the closing lines.
 *
 * Overwrite rules:
 *   - Without `--force`, an existing intent.md, .env, agent.json, .mcp.json or
 *     .claude/settings.json stops `init` before it asks anything.
 *   - With `--force` they are rewritten; `.env` keeps every key it does not
 *     set, and `agent.json` keeps its settings (only `--model` changes one).
 *   - `.gitignore` is always merged: missing lines are appended, none removed.
 *   - `wallet.keypair.json` is never overwritten, `--force` or not. When it
 *     exists and a new wallet is asked for, the existing one is kept and used.
 *
 * Nothing here reads or prints a secret key: wallet.ts returns only the path
 * and the public key.
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { createInterface, type Interface } from 'node:readline';

import type { InitArgs } from '../cli.js';
import { DEFAULT_RPC_URL } from '../config.js';
import { BILLBOARD_ADDRESS, decodeBillboard } from '../program/layout.js';
import { lamportsToSol, minimumBid, solToLamports } from '../program/math.js';
import { withTimeout, type Rpc } from '../rpc/Rpc.js';
import { SolanaRpc } from '../rpc/SolanaRpc.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../version.js';
import {
  AgentFolderError,
  agentEnvValues,
  agentPaths,
  agentSettingsFile,
  claudeMdWarning,
  findClaudeMdFiles,
  readAgentSettings,
  updateGitignoreText,
  writeEnvFile,
  writeFileAtomic,
  type AgentPaths,
  type AgentSettings,
} from './folder.js';
import {
  IntentTemplateError,
  normaliseBelief,
  renderIntent,
  type AgentMode,
} from './intent-template.js';
import {
  agentPlatform,
  claudeSettings,
  mcpConfig,
  toJsonFile,
  type AgentPlatform,
} from './settings.js';
import { WalletError, createWallet, importWallet, type WalletInfo } from './wallet.js';

export class InitError extends Error {
  override readonly name = 'InitError';
  constructor(message: string) {
    super(message);
  }
}

/** How long `init` waits for the live board before carrying on without it. */
export const BOARD_READ_TIMEOUT_MS = 10_000;

/** What the closing lines add to the per-bid limit to cover transaction fees, in lamports. */
export const FEE_ALLOWANCE_LAMPORTS = 20_000_000n;

/** The locked wording, in the order `init` asks. */
export const INIT_QUESTIONS = {
  belief: 'What should your agent tell every other agent? One or two sentences, in your words.',
  maxBid: 'The most it may pay for one bid, in SOL.',
  dailyCap: (fallback: string): string =>
    `The most it may spend in any 24 hours, in SOL. [${fallback}]`,
  mode: 'Should it act on its own inside those limits, or ask you before every bid? [propose/auto]',
  modeAuto: "auto: needed for 'run'; it bids by itself within your limits.",
  modePropose: 'propose: you approve every bid yourself in Claude Code.',
  wallet: 'Create a new wallet for this agent? [Y/n]',
  keypairPath: 'Path to an existing Solana keypair file:',
} as const;

export const BOARD_OFFLINE_LINE = 'Could not read the board just now; you can still finish setup.';

/** The files an earlier `init` leaves behind; any of them stops a run without `--force`. */
const GUARDED_FILES = ['intent', 'env', 'agentJson', 'mcpJson', 'settings'] as const;

/** How each file is named in output, the same on every platform. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  keypair: 'wallet.keypair.json',
  intent: 'intent.md',
  env: '.env',
  agentJson: 'agent.json',
  mcpJson: '.mcp.json',
  settings: '.claude/settings.json',
  gitignore: '.gitignore',
};

/** What a rehearsal needs. The rehearsal itself lives in rehearse.ts. */
export interface RehearsalInput {
  paths: AgentPaths;
  belief: string;
  maxBidSol: string;
  dailyCapSol: string;
  mode: AgentMode;
  /** Prints one line. */
  line: (text: string) => void;
}

export type Rehearse = (input: RehearsalInput) => Promise<void>;

export interface InitIo {
  /** Where answers are read from. Default `process.stdin`. */
  input: NodeJS.ReadableStream;
  /** True when answers can be asked for. Default: stdin is a TTY. */
  interactive: boolean;
  /** stdout, no newline added. */
  write: (text: string) => void;
  /** stderr, no newline added. */
  writeErr: (text: string) => void;
}

export interface InitDeps {
  io?: Partial<InitIo>;
  /** Directory `dir` and `--keypair` resolve against. Default `process.cwd()`. */
  cwd?: string;
  platform?: AgentPlatform;
  /** The board reader. Default: a `SolanaRpc` on agent.json's `rpc_url` (or the default). */
  rpc?: Pick<Rpc, 'getAccount'>;
  boardTimeoutMs?: number;
  /** Version pinned in `.mcp.json`. Default: this package's. */
  version?: string;
  /** Injected so the CLAUDE.md check is host-independent in tests. */
  claudeMdExists?: (path: string) => boolean;
  /** Injected for tests; passed to `createWallet` (POSIX only). */
  chmod?: (path: string, mode: number) => void;
  /** The sandbox rehearsal. Absent: `init` says it was not run. */
  rehearse?: Rehearse;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** A SOL amount above 0 with at most 9 decimals, in canonical form (`0.20` → `0.2`). */
export function parsePositiveSol(value: string): string | null {
  let lamports: bigint;
  try {
    lamports = solToLamports(value.trim());
  } catch {
    return null;
  }
  return lamports > 0n ? lamportsToSol(lamports) : null;
}

const SOL_RULE = 'a SOL amount above 0 with at most 9 decimals, like 0.25';

function solFlag(flag: string, value: string): string {
  const sol = parsePositiveSol(value);
  if (sol === null) throw new InitError(`${flag} must be ${SOL_RULE}, not ${value}`);
  return sol;
}

function capBelowMax(cap: string, max: string): boolean {
  return solToLamports(cap) < solToLamports(max);
}

function doubled(sol: string): string {
  return lamportsToSol(solToLamports(sol) * 2n);
}

// ---------------------------------------------------------------------------
// The live board
// ---------------------------------------------------------------------------

/**
 * The minimum bid on the board right now, in lamports, or null when it could
 * not be read (offline, timeout, missing or malformed account). Never throws.
 */
export async function readBoardMinimum(
  rpc: Pick<Rpc, 'getAccount'>,
  timeoutMs: number = BOARD_READ_TIMEOUT_MS,
): Promise<bigint | null> {
  try {
    const data = await withTimeout(
      rpc.getAccount(BILLBOARD_ADDRESS),
      timeoutMs,
      'reading the board',
    );
    if (data === null) return null;
    return minimumBid(decodeBillboard(data).amount);
  } catch {
    return null;
  }
}

function defaultRpc(paths: AgentPaths): Pick<Rpc, 'getAccount'> {
  let rpcUrl = DEFAULT_RPC_URL;
  try {
    rpcUrl = readAgentSettings(paths.agentJson).rpc_url;
  } catch {
    // An unreadable agent.json is reported when it is rewritten; read the board anyway.
  }
  return new SolanaRpc({ rpcUrl, requestTimeoutMs: BOARD_READ_TIMEOUT_MS });
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** Reads answers one line at a time. Lines that arrive early are queued. */
class Prompter {
  private readonly rl: Interface;
  private readonly queue: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private closed = false;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly write: (text: string) => void,
  ) {
    this.rl = createInterface({ input, terminal: false, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      const waiting = this.waiting;
      this.waiting = null;
      if (waiting) waiting(line);
      else this.queue.push(line);
    });
    this.rl.on('close', () => {
      this.closed = true;
      const waiting = this.waiting;
      this.waiting = null;
      waiting?.(null);
    });
  }

  async ask(question: string): Promise<string> {
    this.write(`${question}\n> `);
    const queued = this.queue.shift();
    const line =
      queued ?? (this.closed ? null : await new Promise<string | null>((r) => (this.waiting = r)));
    if (line === null) {
      this.write('\n');
      throw new InitError('input ended before every question was answered');
    }
    return line.trim();
  }

  close(): void {
    this.rl.close();
  }
}

interface Answers {
  belief: string;
  maxBid: string;
  dailyCap: string;
  mode: AgentMode;
  /** Path to an existing keypair, or null for the folder's own wallet. */
  keypair: string | null;
}

/** The flags still missing, named the way `--help` names them. */
function missingFlags(args: InitArgs, withDefaults: boolean): string[] {
  const missing: string[] = [];
  if (args.belief === null) missing.push('--belief');
  if (args.maxBid === null) missing.push('--max-bid');
  if (withDefaults) {
    if (args.dailyCap === null) missing.push('--daily-cap');
    if (args.mode === null) missing.push('--mode');
    if (!args.newWallet && args.keypair === null) missing.push('--new-wallet or --keypair');
  }
  return missing;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/** Runs `init`. Returns the exit code: 0 done, 2 refused (nothing written). */
export async function runInit(args: InitArgs, deps: InitDeps = {}): Promise<number> {
  const io: InitIo = {
    input: deps.io?.input ?? process.stdin,
    interactive: deps.io?.interactive ?? process.stdin.isTTY === true,
    write: deps.io?.write ?? ((text) => void process.stdout.write(text)),
    writeErr: deps.io?.writeErr ?? ((text) => void process.stderr.write(text)),
  };
  try {
    await init(args, deps, io);
    return 0;
  } catch (err) {
    if (!(err instanceof InitError)) throw err;
    io.writeErr(`${PACKAGE_NAME}: init: ${err.message}\n`);
    io.writeErr(`Run '${PACKAGE_NAME} init --help' for usage.\n`);
    return 2;
  }
}

async function init(args: InitArgs, deps: InitDeps, io: InitIo): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = agentPaths(args.dir, cwd);
  const line = (text = ''): void => io.write(`${text}\n`);

  // 1. An existing agent is never rewritten by accident.
  if (!args.force) {
    const present = GUARDED_FILES.filter((key) => existsSync(paths[key]));
    if (present.length > 0) {
      throw new InitError(
        `${paths.dir} already holds an agent (${present.map((k) => DISPLAY_NAMES[k]).join(', ')}). ` +
          'Use --force to rewrite those files (the wallet file is never touched), or choose another folder.',
      );
    }
  }

  // 2. What can be asked, and what was given.
  const ask = io.interactive && !args.yes;
  if (!ask) {
    const missing = missingFlags(args, !args.yes);
    if (missing.length > 0) {
      const why = args.yes
        ? '--yes never asks, so give them as flags.'
        : 'stdin is not a terminal, so nothing can be asked; give them as flags, or add --yes to take the defaults for the daily cap, mode and wallet.';
      throw new InitError(`missing ${missing.join(', ')}. ${why}`);
    }
  }
  let belief: string | null = null;
  if (args.belief !== null) {
    try {
      belief = normaliseBelief(args.belief);
    } catch (err) {
      throw new InitError(`--belief: ${(err as IntentTemplateError).message}`);
    }
  }
  const maxBidFlag = args.maxBid === null ? null : solFlag('--max-bid', args.maxBid);
  const dailyCapFlag = args.dailyCap === null ? null : solFlag('--daily-cap', args.dailyCap);
  if (maxBidFlag !== null && dailyCapFlag !== null && capBelowMax(dailyCapFlag, maxBidFlag)) {
    throw new InitError(
      `--daily-cap (${dailyCapFlag} SOL) cannot be below --max-bid (${maxBidFlag} SOL)`,
    );
  }
  let imported: WalletInfo | null = null;
  if (args.keypair !== null) imported = importFlagKeypair(args.keypair, cwd);

  // 3. The live board, read while the first question is answered.
  const rpc = deps.rpc ?? defaultRpc(paths);
  const boardMinimum = readBoardMinimum(rpc, deps.boardTimeoutMs ?? BOARD_READ_TIMEOUT_MS);

  // 4. The questions.
  const prompter = ask ? new Prompter(io.input, io.write) : null;
  let answers: Answers;
  try {
    answers = await gather(args, prompter, line, cwd, {
      belief,
      maxBid: maxBidFlag,
      dailyCap: dailyCapFlag,
      imported,
      boardMinimum,
    });
  } finally {
    prompter?.close();
  }
  if (answers.keypair !== null && imported === null) imported = importWallet(answers.keypair, cwd);

  // 5. The CLAUDE.md warning, then the files.
  for (const found of findClaudeMdFiles(paths.dir, deps.claudeMdExists)) {
    io.writeErr(`Warning: ${claudeMdWarning(found)}\n`);
  }
  const wallet = writeFolder(paths, answers, imported, args, deps, cwd, line);

  // 6. The rehearsal.
  if (args.skipRehearsal) {
    line('Rehearsal skipped (--skip-rehearsal).');
  } else if (deps.rehearse === undefined) {
    line('The sandbox rehearsal is not part of this build; skipped.');
  } else {
    await deps.rehearse({
      paths,
      belief: answers.belief,
      maxBidSol: answers.maxBid,
      dailyCapSol: answers.dailyCap,
      mode: answers.mode,
      line,
    });
  }

  // 7. The closing lines.
  const minimum = await boardMinimum;
  line();
  line(`Your agent's wallet: ${wallet.publicKey}`);
  const fund = lamportsToSol(solToLamports(answers.maxBid) + FEE_ALLOWANCE_LAMPORTS);
  line(`Fund it with ${fund} SOL to go live (0.02 covers fees).`);
  line(
    minimum === null
      ? BOARD_OFFLINE_LINE
      : `The board's minimum bid right now: ${lamportsToSol(minimum)} SOL`,
  );
  const cdTarget = /\s/.test(args.dir) ? `"${args.dir}"` : args.dir;
  line(`Next:  cd ${cdTarget}`);
  line(
    `       npx ${PACKAGE_NAME} run --sandbox     (one rehearsal wake with your own Claude Code)`,
  );
  line(`       npx ${PACKAGE_NAME} run               (live; auto mode only)`);
  line(`       npx ${PACKAGE_NAME} report`);
  if (minimum !== null && solToLamports(answers.maxBid) < minimum) {
    line();
    line(
      "Your per-bid limit is below the board's minimum. The price only goes up, so this agent cannot post until you raise MAX_BID_SOL in .env.",
    );
  }
}

function importFlagKeypair(path: string, cwd: string): WalletInfo {
  try {
    return importWallet(path, cwd);
  } catch (err) {
    if (err instanceof WalletError) throw new InitError(`--keypair: ${err.message}`);
    throw err;
  }
}

interface Known {
  belief: string | null;
  maxBid: string | null;
  dailyCap: string | null;
  imported: WalletInfo | null;
  boardMinimum: Promise<bigint | null>;
}

/**
 * Fills every answer: from a flag, from a default (`--yes`, or a
 * non-interactive run that `init` already checked has every flag), or by
 * asking. A bad answer is explained and asked again.
 */
async function gather(
  args: InitArgs,
  prompter: Prompter | null,
  line: (text?: string) => void,
  cwd: string,
  known: Known,
): Promise<Answers> {
  // 1. The belief.
  let belief = known.belief;
  while (belief === null) {
    const answer = await (prompter as Prompter).ask(INIT_QUESTIONS.belief);
    try {
      belief = normaliseBelief(answer);
    } catch (err) {
      line(`${capitalise((err as IntentTemplateError).message)}. Try again.`);
    }
  }

  // 2. The per-bid limit, with the live minimum shown first.
  let maxBid = known.maxBid;
  if (maxBid === null) {
    const minimum = await known.boardMinimum;
    line(
      minimum === null
        ? BOARD_OFFLINE_LINE
        : `The minimum bid on the board right now is ${lamportsToSol(minimum)} SOL.`,
    );
  }
  while (maxBid === null) {
    const sol = parsePositiveSol(await (prompter as Prompter).ask(INIT_QUESTIONS.maxBid));
    if (sol === null) line(`Give ${SOL_RULE}.`);
    else if (known.dailyCap !== null && capBelowMax(known.dailyCap, sol)) {
      line(
        `That is above your --daily-cap of ${known.dailyCap} SOL. Give ${known.dailyCap} or less.`,
      );
    } else maxBid = sol;
  }

  // 3. The rolling 24-hour cap.
  const fallbackCap = doubled(maxBid);
  let dailyCap = known.dailyCap ?? (prompter === null ? fallbackCap : null);
  while (dailyCap === null) {
    const answer = await (prompter as Prompter).ask(INIT_QUESTIONS.dailyCap(fallbackCap));
    const sol = answer === '' ? fallbackCap : parsePositiveSol(answer);
    if (sol === null) line(`Give ${SOL_RULE}, or press Enter for ${fallbackCap}.`);
    else if (capBelowMax(sol, maxBid)) {
      line(`The daily cap cannot be below the per-bid limit (${maxBid} SOL).`);
    } else dailyCap = sol;
  }

  // 4. The mode.
  let mode: AgentMode | null = args.mode ?? (prompter === null ? 'propose' : null);
  if (mode === null) {
    line(INIT_QUESTIONS.modeAuto);
    line(INIT_QUESTIONS.modePropose);
  }
  while (mode === null) {
    const answer = (await (prompter as Prompter).ask(INIT_QUESTIONS.mode)).toLowerCase();
    if (answer === '' || answer === 'propose') mode = 'propose';
    else if (answer === 'auto') mode = 'auto';
    else line('Answer propose or auto.');
  }

  // The wallet.
  let keypair: string | null = known.imported?.path ?? null;
  let decided = args.newWallet || known.imported !== null || prompter === null;
  while (!decided) {
    const answer = (await (prompter as Prompter).ask(INIT_QUESTIONS.wallet)).toLowerCase();
    if (answer === '' || answer === 'y' || answer === 'yes') decided = true;
    else if (answer === 'n' || answer === 'no') {
      while (keypair === null) {
        const path = await (prompter as Prompter).ask(INIT_QUESTIONS.keypairPath);
        try {
          keypair = importWallet(path, cwd).path;
        } catch (err) {
          if (!(err instanceof WalletError)) throw err;
          line(`${capitalise(err.message)} Try again.`);
        }
      }
      decided = true;
    } else line('Answer y or n.');
  }

  return { belief, maxBid, dailyCap, mode, keypair };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function writeFolder(
  paths: AgentPaths,
  answers: Answers,
  imported: WalletInfo | null,
  args: InitArgs,
  deps: InitDeps,
  cwd: string,
  line: (text?: string) => void,
): WalletInfo {
  const platform = deps.platform ?? agentPlatform();
  const written: Array<[string, string]> = [];

  // The wallet first: if it cannot be made, nothing else is worth writing.
  let wallet: WalletInfo;
  if (imported !== null) {
    wallet = imported;
    written.push(['(wallet)', `your keypair file at ${wallet.path}, used where it is`]);
  } else if (existsSync(paths.keypair)) {
    wallet = importWallet(paths.keypair);
    written.push([DISPLAY_NAMES.keypair as string, 'kept: a keypair file is never overwritten']);
  } else {
    wallet = createWallet(paths.keypair, {
      platform,
      ...(deps.chmod === undefined ? {} : { chmod: deps.chmod }),
    });
    written.push([
      DISPLAY_NAMES.keypair as string,
      "the agent's new wallet. Its secret key: never share it, never commit it",
    ]);
  }

  writeFileAtomic(
    paths.intent,
    renderIntent({
      belief: answers.belief,
      maxBidSol: answers.maxBid,
      dailyCapSol: answers.dailyCap,
      mode: answers.mode,
    }),
  );
  written.push([
    DISPLAY_NAMES.intent as string,
    'your brief to the agent; edit it in your own words',
  ]);

  writeEnvFile(
    paths.env,
    agentEnvValues({
      keypairPath: wallet.path,
      maxBidSol: answers.maxBid,
      dailyCapSol: answers.dailyCap,
      autoBid: answers.mode === 'auto',
    }),
  );
  written.push([DISPLAY_NAMES.env as string, 'the wallet path, your limits and the mode']);

  let settings: Partial<AgentSettings> = {};
  let settingsNote = 'settings for run (defaults)';
  if (existsSync(paths.agentJson)) {
    try {
      settings = readAgentSettings(paths.agentJson);
      settingsNote = 'settings for run (yours kept)';
    } catch (err) {
      if (!(err instanceof AgentFolderError)) throw err;
      settingsNote = 'settings for run (the old file was invalid; defaults written)';
    }
  }
  if (args.model !== null) settings = { ...settings, model: args.model };
  writeFileAtomic(paths.agentJson, agentSettingsFile(settings));
  written.push([DISPLAY_NAMES.agentJson as string, settingsNote]);

  const version = deps.version ?? PACKAGE_VERSION;
  writeFileAtomic(paths.mcpJson, toJsonFile(mcpConfig({ platform, version })));
  written.push([
    DISPLAY_NAMES.mcpJson as string,
    `starts ${PACKAGE_NAME}@${version} for Claude Code`,
  ]);

  writeFileAtomic(paths.settings, toJsonFile(claudeSettings()));
  written.push([
    DISPLAY_NAMES.settings as string,
    "locks Claude Code in this folder to the billboard's tools",
  ]);

  const gitignore = existsSync(paths.gitignore) ? readFileSync(paths.gitignore, 'utf8') : null;
  const merged = updateGitignoreText(gitignore);
  if (merged !== gitignore) writeFileAtomic(paths.gitignore, merged);
  written.push([DISPLAY_NAMES.gitignore as string, 'keeps the wallet, .env and logs out of git']);

  const shown = relative(cwd, paths.dir) || '.';
  line(`Agent folder: ${shown.startsWith('..') ? paths.dir : shown}`);
  const width = Math.max(...written.map(([name]) => name.length)) + 2;
  for (const [name, note] of written) line(`  ${name.padEnd(width)}${note}`);
  return wallet;
}
