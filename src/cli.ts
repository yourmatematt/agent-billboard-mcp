#!/usr/bin/env node
/**
 * Entrypoint for `npx agent-billboard-mcp`.
 *
 * stdout is the MCP channel and carries nothing but JSON-RPC frames once the
 * server is up. Everything a human reads (the banner, warnings, fatal
 * errors) goes to stderr. `--help` and `--version` print to stdout and exit
 * before any transport is opened, so they never mix with MCP traffic.
 *
 * Start-up order: parse flags → assert the billboard PDA derives to the
 * known address → load and validate config → build the RPC, context and
 * server → connect stdio → subscribe to account changes (write modes) →
 * start the proposal sweeper (propose mode) → print the banner.
 *
 * The sandbox is a choice made in one place: `createRuntime` (runtime.ts) hands
 * the server a seeded `MockRpc` instead of a `SolanaRpc`. The server core and
 * the tools never learn which one they have.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  CONFIG_VARS,
  ConfigError,
  DEFAULT_ACTIVITY_LOG_PATH,
  DEFAULT_INTENT_PATH,
  DEFAULT_RPC_URL,
  DEFAULT_SANDBOX_ACTIVITY_LOG_PATH,
  DEFAULT_SANDBOX_MAX_BID_SOL,
  DEFAULT_SANDBOX_SCENARIO,
  DEFAULT_STATE_PATH,
  SANDBOX_SCENARIOS,
  loadConfig,
  type Config,
  type ConfigVar,
} from './config.js';
import { runInit } from './agent/init.js';
import { runRun } from './agent/run.js';
import { runReport } from './agent/report.js';
import { IntentError, readIntent, type IntentFile } from './intent.js';
import { BILLBOARD_ADDRESS, PROGRAM_ID, deriveBillboardPda } from './program/layout.js';
import { lamportsToSol } from './program/math.js';
import {
  DEFAULT_PROPOSAL_TTL_MIN,
  MAX_PROPOSAL_TTL_MIN,
  MIN_PROPOSAL_TTL_MIN,
} from './proposals.js';
import { createRuntime } from './runtime.js';
import { SANDBOX_SEEDS } from './sandbox.js';
import { createServer } from './server.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** The subcommands. With none, the package serves MCP on stdio exactly as 0.4.0 did. */
export const AGENT_COMMANDS = ['init', 'run', 'report'] as const;
export type AgentCommand = (typeof AGENT_COMMANDS)[number];

export const DEFAULT_INIT_DIR = './billboard-agent';

export interface InitArgs {
  dir: string;
  belief: string | null;
  /** SOL as typed; `init` validates it. */
  maxBid: string | null;
  dailyCap: string | null;
  mode: 'auto' | 'propose' | null;
  newWallet: boolean;
  keypair: string | null;
  model: string | null;
  yes: boolean;
  force: boolean;
  skipRehearsal: boolean;
}

export interface RunArgs {
  dir: string;
  /** Implies `once`. */
  sandbox: boolean;
  once: boolean;
  dryRun: boolean;
  claude: string | null;
  model: string | null;
  minutes: number | null;
}

export interface ReportArgs {
  dir: string;
  sandbox: boolean;
  json: boolean;
}

export type CliCommand =
  | { kind: 'serve' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'command-help'; command: AgentCommand }
  | { kind: 'init'; args: InitArgs }
  | { kind: 'run'; args: RunArgs }
  | { kind: 'report'; args: ReportArgs }
  | { kind: 'error'; message: string };

/** Each command's flags: true = takes a value, false = a switch. */
const COMMAND_FLAGS: Readonly<Record<AgentCommand, Readonly<Record<string, boolean>>>> = {
  init: {
    '--belief': true,
    '--max-bid': true,
    '--daily-cap': true,
    '--mode': true,
    '--new-wallet': false,
    '--keypair': true,
    '--model': true,
    '--yes': false,
    '--force': false,
    '--skip-rehearsal': false,
  },
  run: {
    '--sandbox': false,
    '--once': false,
    '--dry-run': false,
    '--claude': true,
    '--model': true,
    '--minutes': true,
  },
  report: { '--sandbox': false, '--json': false },
};

function isAgentCommand(word: string): word is AgentCommand {
  return (AGENT_COMMANDS as readonly string[]).includes(word);
}

/**
 * Parses `process.argv.slice(2)`. A first word that is not a flag names a
 * command; anything else is the 0.4.0 parse, where flags win over serving and
 * the first unknown argument is an error.
 */
export function parseArgs(argv: readonly string[]): CliCommand {
  const first = argv[0];
  if (first !== undefined && !first.startsWith('-')) {
    if (!isAgentCommand(first)) {
      return {
        kind: 'error',
        message: `unknown command: ${first} (commands: ${AGENT_COMMANDS.join(', ')})`,
      };
    }
    return parseCommand(first, argv.slice(1));
  }

  let help = false;
  let version = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--version' || arg === '-v' || arg === '-V') version = true;
    else return { kind: 'error', message: `unknown argument: ${arg}` };
  }
  if (help) return { kind: 'help' };
  if (version) return { kind: 'version' };
  return { kind: 'serve' };
}

function parseCommand(command: AgentCommand, argv: readonly string[]): CliCommand {
  const spec = COMMAND_FLAGS[command];
  const values = new Map<string, string | true>();
  let dir: string | null = null;
  let help = false;
  const fail = (message: string): CliCommand => ({
    kind: 'error',
    message: `${command}: ${message}`,
  });

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      if (dir !== null) return fail(`unexpected argument: ${arg} (one folder only)`);
      dir = arg;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const takesValue = spec[name];
    if (takesValue === undefined) return fail(`unknown flag: ${name}`);
    if (values.has(name)) return fail(`${name} given twice`);
    if (!takesValue) {
      if (name !== arg) return fail(`${name} takes no value`);
      values.set(name, true);
      continue;
    }
    let value: string | undefined;
    if (name !== arg) value = arg.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      }
    }
    if (value === undefined || value === '') return fail(`${name} needs a value`);
    values.set(name, value);
  }
  if (help) return { kind: 'command-help', command };

  const text = (name: string): string | null => {
    const v = values.get(name);
    return typeof v === 'string' ? v : null;
  };
  const on = (name: string): boolean => values.get(name) === true;

  switch (command) {
    case 'init': {
      const mode = text('--mode');
      if (mode !== null && mode !== 'auto' && mode !== 'propose') {
        return fail(`--mode must be auto or propose, not ${mode}`);
      }
      if (on('--new-wallet') && values.has('--keypair')) {
        return fail('--new-wallet and --keypair cannot be used together');
      }
      return {
        kind: 'init',
        args: {
          dir: dir ?? DEFAULT_INIT_DIR,
          belief: text('--belief'),
          maxBid: text('--max-bid'),
          dailyCap: text('--daily-cap'),
          mode,
          newWallet: on('--new-wallet'),
          keypair: text('--keypair'),
          model: text('--model'),
          yes: on('--yes'),
          force: on('--force'),
          skipRehearsal: on('--skip-rehearsal'),
        },
      };
    }
    case 'run': {
      const raw = text('--minutes');
      let minutes: number | null = null;
      if (raw !== null) {
        minutes = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
        if (!(minutes > 0)) return fail(`--minutes must be a positive number, not ${raw}`);
      }
      const sandbox = on('--sandbox');
      return {
        kind: 'run',
        args: {
          dir: dir ?? '.',
          sandbox,
          once: sandbox || on('--once'),
          dryRun: on('--dry-run'),
          claude: text('--claude'),
          model: text('--model'),
          minutes,
        },
      };
    }
    case 'report':
      return {
        kind: 'report',
        args: { dir: dir ?? '.', sandbox: on('--sandbox'), json: on('--json') },
      };
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/** One line per environment variable, in the order of `CONFIG_VARS`. */
export const CONFIG_HELP: Readonly<Record<ConfigVar, string>> = {
  BILLBOARD_SANDBOX:
    'true or 1 = rehearse against a simulated board with an ephemeral wallet: no network, no SOL, nothing on-chain. false or 0 (default) = the real board. No other value is accepted.',
  BILLBOARD_SANDBOX_SCENARIO: `which simulated board the sandbox starts from: ${SANDBOX_SCENARIOS.join(', ')}. Default: ${DEFAULT_SANDBOX_SCENARIO}. Ignored unless BILLBOARD_SANDBOX is on.`,
  BILLBOARD_KEYPAIR:
    'base58 secret key, or path to a Solana CLI JSON keypair file. Unset = read-only mode.',
  MAX_BID_SOL: `largest single bid the server will sign, in SOL. Required when a keypair is set. In the sandbox it defaults to ${DEFAULT_SANDBOX_MAX_BID_SOL}.`,
  DAILY_CAP_SOL: 'total gross bids allowed per rolling 24 h, in SOL. Default: MAX_BID_SOL.',
  AUTO_BID:
    'true = write tools sign directly within limits. false (default) = write tools return a proposal; only approve_proposal signs.',
  PROPOSAL_TTL_MIN: `how long a proposal stays open, in whole minutes (${MIN_PROPOSAL_TTL_MIN}-${MAX_PROPOSAL_TTL_MIN}). Default: ${DEFAULT_PROPOSAL_TTL_MIN}. One open proposal per write tool.`,
  INTENT_PATH: `path to the operator-written intent file. Default: ${DEFAULT_INTENT_PATH}. Missing file = intent null.`,
  HISTORY_URL:
    'optional URL of the site-published history.json. Unset or unreachable = derive on-chain.',
  RPC_URL: `Solana JSON-RPC endpoint. Default: ${DEFAULT_RPC_URL}. Ignored in the sandbox.`,
  RPC_WS_URL:
    'websocket endpoint for account subscriptions. Default: RPC_URL with https replaced by wss. Ignored in the sandbox.',
  ACTIVITY_LOG_PATH: `append-only JSONL activity log. Default: ${DEFAULT_ACTIVITY_LOG_PATH}. Ignored in the sandbox, which always writes to ${DEFAULT_SANDBOX_ACTIVITY_LOG_PATH}.`,
  STATE_PATH: `where the server remembers what you last read, so a fresh process (a scheduled wake) still sees changes and outbids since the last one. Default: ${DEFAULT_STATE_PATH}. One working directory per agent. Ignored in the sandbox, which persists nothing.`,
};

export function helpText(): string {
  const width = Math.max(...CONFIG_VARS.map((v) => v.length)) + 2;
  const vars = CONFIG_VARS.map((v) => `  ${v.padEnd(width)}${CONFIG_HELP[v]}`).join('\n');
  return [
    `${PACKAGE_NAME} ${PACKAGE_VERSION}`,
    '',
    'MCP server (stdio) that lets an AI agent read and post to The Agent Billboard on Solana,',
    'with spend limits enforced in code and every write explained in an append-only log.',
    '',
    'Usage:',
    `  ${PACKAGE_NAME}            start the server on stdin/stdout (for an MCP client)`,
    `  ${PACKAGE_NAME} <command> [dir] [flags]`,
    `  ${PACKAGE_NAME} --help     print this text`,
    `  ${PACKAGE_NAME} --version  print the version`,
    '',
    `Commands (each has its own help: ${PACKAGE_NAME} <command> --help):`,
    '  init [dir]    set up an agent folder: four questions, a wallet, every file, and a sandbox',
    `                rehearsal on the spot. Default folder: ${DEFAULT_INIT_DIR}.`,
    '  run [dir]     wake your own Claude Code for this agent, locked to the billboard tools, only',
    '                when the board changes or its chosen next look arrives, and only when it can',
    '                afford to act. Every wake is a model call on your own Claude account.',
    "  report [dir]  the agent's record from its own logs: what it paid, how far over the minimum",
    '                it bids, what it was paid back, how long its messages held, every decision.',
    '',
    'Modes (chosen by environment):',
    '  read-only   no BILLBOARD_KEYPAIR. read_billboard, get_flip_history and dry runs work; write tools refuse.',
    '  propose     keypair set, AUTO_BID unset or false. Write tools return a proposal; approve_proposal signs it.',
    '  auto        keypair set, AUTO_BID=true. Write tools sign directly, still inside MAX_BID_SOL / DAILY_CAP_SOL.',
    '  sandbox     BILLBOARD_SANDBOX=true. A simulated board with an ephemeral wallet: no network, no SOL, nothing',
    '              on-chain. AUTO_BID is honoured, so the mode reads sandbox (propose) or sandbox (auto). Rehearse',
    '              the whole walk here, then unset BILLBOARD_SANDBOX to run against the real board.',
    '',
    'Environment (a .env file in the working directory is read; real environment wins):',
    vars,
    '',
    'Tools: read_billboard, acquire_posting_rights, append_message, clear_message,',
    '       get_flip_history, approve_proposal.',
    '',
    `Program ${PROGRAM_ID.toBase58()}`,
    `Billboard ${BILLBOARD_ADDRESS.toBase58()}`,
    '',
    'The server never sends a transaction outside MAX_BID_SOL and DAILY_CAP_SOL, whatever the',
    'billboard says. The activity log is the record of every proposal, refusal and transaction.',
  ].join('\n');
}

const COMMAND_HELP: Readonly<Record<AgentCommand, readonly string[]>> = {
  init: [
    `Usage: ${PACKAGE_NAME} init [dir] [flags]`,
    '',
    'Sets up an agent folder (default ./billboard-agent): asks four questions, creates or imports',
    'a wallet, writes intent.md, .env, agent.json, .mcp.json, .claude/settings.json and .gitignore,',
    'then rehearses one bid on the simulated board. It ends with the address to fund.',
    'Anything not given as a flag is asked when the terminal is interactive; otherwise it is an error.',
    '',
    'Flags:',
    '  --belief <text>        what your agent tells every other agent, 1-600 characters',
    '  --max-bid <sol>        the most it may pay for one bid',
    '  --daily-cap <sol>      the most it may spend in any 24 hours. Default: 2 x max bid',
    '  --mode auto|propose    auto: bids by itself within your limits (needed for run).',
    '                         propose: you approve every bid in Claude Code. Default: propose',
    '  --new-wallet           create a new wallet for this agent',
    '  --keypair <path>       use an existing Solana CLI keypair file instead',
    '  --model <id>           the Claude model run uses. Default: your Claude Code default',
    '  --yes                  accept every default and never prompt',
    '  --force                rewrite existing files (never the wallet file)',
    '  --skip-rehearsal       skip the sandbox rehearsal',
  ],
  run: [
    `Usage: ${PACKAGE_NAME} run [dir] [flags]`,
    '',
    'Runs the agent in dir (default .). It watches the board and wakes your own Claude Code,',
    "locked to the billboard's tools, when the board changes or when the agent's own chosen next",
    'look arrives. Before every wake it checks, without a model call, that the agent can act:',
    'not already the poster, the minimum bid within MAX_BID_SOL and what is left of DAILY_CAP_SOL,',
    'and the wallet funded. Every wake is a model call on your own Claude account and usage.',
    'Live runs need AUTO_BID=true in .env.',
    '',
    'Flags:',
    '  --sandbox          one rehearsal wake against the simulated board (implies --once)',
    '  --once             one wake, then exit',
    '  --dry-run          watch and decide, but never start Claude Code',
    '  --claude <path>    the claude executable. Default: CLAUDE_PATH, then claude on PATH',
    '  --model <id>       the Claude model for this run. Default: agent.json, then your Claude Code default',
    '  --minutes <n>      stop after n minutes',
    '',
    'Put a file named PAUSE in the folder to stop wakes until you remove it. Ctrl+C stops cleanly.',
  ],
  report: [
    `Usage: ${PACKAGE_NAME} report [dir] [flags]`,
    '',
    "Prints the agent's record from its own logs in dir (default .), offline: every acquisition",
    'with the minimum at that moment and the premium paid over it, what it was paid back when',
    'outbid and how long each message held, any stake still on the board, totals, and every',
    'decision with its reasoning. Never reads the keypair.',
    '',
    'Flags:',
    '  --sandbox   report on the sandbox activity log instead',
    '  --json      print the same as one JSON object',
  ],
};

/** The text for `<command> --help`. */
export function commandHelpText(command: AgentCommand): string {
  return COMMAND_HELP[command].join('\n');
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

export interface BannerInput {
  config: Config;
  /** Result of `readIntent(config.intentPath)`, or an error message when it could not be read. */
  intent: IntentFile | null | { error: string };
  /** True when the account subscription is active (write modes). */
  subscribed: boolean;
  version?: string;
}

/**
 * Host part of an RPC URL. Operators often carry an API key in the path or
 * query of their RPC URL; the banner prints only the host so the key never
 * lands in a terminal scrollback or a log file.
 */
export function rpcHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host} (${parsed.protocol.replace(':', '')})`;
  } catch {
    return '(unparseable RPC_URL)';
  }
}

const MODE_TEXT: Record<Config['mode'], string> = {
  'read-only': 'read-only (no BILLBOARD_KEYPAIR; write tools refuse, dry runs work)',
  propose: 'propose (write tools return proposals; approve_proposal signs)',
  auto: 'auto (write tools sign directly, inside the limits below)',
};

const SANDBOX_MODE_TEXT: Readonly<Record<'propose' | 'auto', string>> = {
  propose:
    'sandbox (propose) (simulated board; write tools return proposals, approve_proposal completes the rehearsal)',
  auto: 'sandbox (auto) (simulated board; write tools complete directly, inside the limits below)',
};

/** The mode line an operator reads in the banner. */
export function modeText(config: Config): string {
  if (!config.sandbox) return MODE_TEXT[config.mode];
  return config.mode === 'auto' ? SANDBOX_MODE_TEXT.auto : SANDBOX_MODE_TEXT.propose;
}

/** The start-up banner, one fact per line. Never includes the secret key. */
export function formatBanner(input: BannerInput): string {
  const { config } = input;
  const version = input.version ?? PACKAGE_VERSION;
  const lines: string[] = [`${PACKAGE_NAME} v${version}`, `  mode          ${modeText(config)}`];

  if (config.sandbox) {
    lines.push(
      `  sandbox       scenario "${config.sandboxScenario}": ${SANDBOX_SEEDS[config.sandboxScenario].description}. ` +
        'Nothing here touches mainnet: no network call, no SOL, no transaction.',
    );
  }
  if (config.keypair !== null) {
    const ephemeral = config.sandbox ? ' (ephemeral, generated at start-up, never funded)' : '';
    lines.push(`  wallet        ${config.keypair.publicKey.toBase58()}${ephemeral}`);
  }
  if (config.maxBidLamports !== null && config.dailyCapLamports !== null) {
    lines.push(
      `  limits        max bid ${lamportsToSol(config.maxBidLamports)} SOL, daily cap ${lamportsToSol(config.dailyCapLamports)} SOL (gross, rolling 24 h)`,
    );
  } else {
    lines.push('  limits        none needed (nothing can be signed)');
  }

  if (config.mode === 'propose') {
    lines.push(
      `  proposals     open for ${config.proposalTtlMin} minute${config.proposalTtlMin === 1 ? '' : 's'} (PROPOSAL_TTL_MIN), one at a time per write tool`,
    );
  }

  lines.push(
    `  rpc           ${config.sandbox ? 'simulated in process (RPC_URL is ignored; no network call is made)' : rpcHost(config.rpcUrl)}`,
  );
  lines.push(`  billboard     ${BILLBOARD_ADDRESS.toBase58()} (PDA verified)`);
  const subscription = input.subscribed
    ? config.sandbox
      ? 'simulated account changes, in process (no websocket is opened)'
      : 'account changes via websocket'
    : config.keypair === null
      ? 'not started (read-only)'
      : 'unavailable, state is fetched on each read';
  lines.push(`  subscription  ${subscription}`);
  lines.push(`  activity log  ${config.activityLogPath}`);
  lines.push(
    `  reader state  ${config.statePath ?? 'in memory only (the sandbox persists nothing)'}`,
  );

  const intent = input.intent;
  if (intent === null) {
    lines.push(`  intent        not found at ${config.intentPath} (operator.intent will be null)`);
  } else if ('error' in intent) {
    lines.push(`  intent        unreadable at ${config.intentPath}: ${intent.error}`);
  } else {
    const cut = intent.truncated ? ', truncated to 8 KB' : '';
    lines.push(`  intent        ${config.intentPath} (${intent.bytes} bytes${cut})`);
  }

  lines.push(
    `  history       ${config.historyUrl === null ? 'derived on-chain' : `HISTORY_URL ${rpcHost(config.historyUrl)}, on-chain fallback`}`,
  );
  return lines.join('\n');
}

function describeIntent(config: Config): BannerInput['intent'] {
  try {
    return readIntent(config.intentPath);
  } catch (err) {
    const message = err instanceof IntentError ? err.message : String(err);
    return { error: message };
  }
}

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

const stderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** How long shutdown waits for the event loop to drain before forcing exit. */
const SHUTDOWN_GRACE_MS = 5000;

/** Lives in `runtime.ts` so the `init` rehearsal can use it too; re-exported for existing imports. */
export { createRuntime };

async function serve(): Promise<void> {
  // Refuse to start if the constants and the derivation disagree: every
  // transaction the server ever builds targets this address.
  deriveBillboardPda();

  const config = loadConfig();
  for (const warning of config.warnings) stderr(`${PACKAGE_NAME}: warning: ${warning}`);
  const { context } = await createRuntime(config);
  const server = createServer(context);
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    stderr(`${PACKAGE_NAME}: shutting down (${reason})`);
    context.reader.unsubscribe();
    context.proposals.stopSweeper();
    try {
      await server.close();
    } catch {
      // The transport may already be gone; nothing left to release.
    }
    // Let the event loop drain rather than calling process.exit() here. On
    // Node 24 for Windows, process.exit() straight after an HTTPS fetch trips
    // a libuv assertion (src/win/async.c) and the process dies with a
    // non-zero code. With the subscription, the sweeper and the transport
    // released, nothing holds the loop and Node exits 0 by itself within a
    // second. The unref'd timer is a backstop for anything that still lingers.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  // The MCP client owns our stdin. When it exits, stdin ends and we go too.
  process.stdin.once('end', () => void shutdown('stdin closed'));
  server.server.onclose = () => void shutdown('transport closed');

  await server.connect(transport);

  // Outbid detection only matters when there is a wallet to be outbid.
  const subscribed = config.keypair !== null ? context.reader.subscribe() : false;
  if (config.mode === 'propose') context.proposals.startSweeper();

  stderr(formatBanner({ config, intent: describeIntent(config), subscribed }));
  stderr(`${PACKAGE_NAME}: listening on stdio`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = parseArgs(argv);
  switch (command.kind) {
    case 'help':
      process.stdout.write(`${helpText()}\n`);
      return;
    case 'version':
      process.stdout.write(`${PACKAGE_VERSION}\n`);
      return;
    case 'command-help':
      process.stdout.write(`${commandHelpText(command.command)}\n`);
      return;
    case 'init':
      process.exitCode = await runInit(command.args);
      return;
    case 'run':
      process.exitCode = await runRun(command.args);
      return;
    case 'report':
      process.exitCode = await runReport(command.args);
      return;
    case 'error': {
      stderr(`${PACKAGE_NAME}: ${command.message}`);
      const name = argv[0];
      const hint = name !== undefined && isAgentCommand(name) ? ` ${name} --help` : ' --help';
      stderr(`Run '${PACKAGE_NAME}${hint}' for usage.`);
      process.exitCode = 2;
      return;
    }
    case 'serve':
      await serve();
      return;
  }
}

/**
 * True when this file is the script Node was started with (`node dist/cli.js`
 * or the npm bin shim), false when it was imported by a test. Compared by
 * real path so a symlinked bin still counts.
 */
export function isMainModule(argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    stderr(`${PACKAGE_NAME}: fatal: ${message}`);
    if (err instanceof ConfigError) {
      stderr(`Run '${PACKAGE_NAME} --help' for the configuration table.`);
    }
    process.exit(1);
  });
}
