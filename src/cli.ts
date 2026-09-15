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
  loadConfig,
  type Config,
  type ConfigVar,
} from './config.js';
import { IntentError, readIntent, type IntentFile } from './intent.js';
import { BILLBOARD_ADDRESS, PROGRAM_ID, deriveBillboardPda } from './program/layout.js';
import { lamportsToSol } from './program/math.js';
import { SolanaRpc } from './rpc/SolanaRpc.js';
import { createContext, createServer } from './server.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export type CliCommand =
  { kind: 'serve' } | { kind: 'help' } | { kind: 'version' } | { kind: 'error'; message: string };

/** Parses `process.argv.slice(2)`. Flags win over serving; the first unknown argument is an error. */
export function parseArgs(argv: readonly string[]): CliCommand {
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

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/** One line per environment variable, in the order of `CONFIG_VARS`. */
export const CONFIG_HELP: Readonly<Record<ConfigVar, string>> = {
  BILLBOARD_KEYPAIR:
    'base58 secret key, or path to a Solana CLI JSON keypair file. Unset = read-only mode.',
  MAX_BID_SOL: 'largest single bid the server will sign, in SOL. Required when a keypair is set.',
  DAILY_CAP_SOL: 'total gross bids allowed per rolling 24 h, in SOL. Default: MAX_BID_SOL.',
  AUTO_BID:
    'true = write tools sign directly within limits. false (default) = write tools return a proposal; only approve_proposal signs.',
  INTENT_PATH: `path to the operator-written intent file. Default: ${DEFAULT_INTENT_PATH}. Missing file = intent null.`,
  HISTORY_URL:
    'optional URL of the site-published history.json. Unset or unreachable = derive on-chain.',
  RPC_URL: `Solana JSON-RPC endpoint. Default: ${DEFAULT_RPC_URL}.`,
  RPC_WS_URL:
    'websocket endpoint for account subscriptions. Default: RPC_URL with https replaced by wss.',
  ACTIVITY_LOG_PATH: `append-only JSONL activity log. Default: ${DEFAULT_ACTIVITY_LOG_PATH}.`,
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
    `  ${PACKAGE_NAME} --help     print this text`,
    `  ${PACKAGE_NAME} --version  print the version`,
    '',
    'Modes (chosen by environment):',
    '  read-only   no BILLBOARD_KEYPAIR. read_billboard, get_flip_history and dry runs work; write tools refuse.',
    '  propose     keypair set, AUTO_BID unset or false. Write tools return a proposal; approve_proposal signs it.',
    '  auto        keypair set, AUTO_BID=true. Write tools sign directly, still inside MAX_BID_SOL / DAILY_CAP_SOL.',
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

/** The start-up banner, one fact per line. Never includes the secret key. */
export function formatBanner(input: BannerInput): string {
  const { config } = input;
  const version = input.version ?? PACKAGE_VERSION;
  const lines: string[] = [
    `${PACKAGE_NAME} v${version}`,
    `  mode          ${MODE_TEXT[config.mode]}`,
  ];

  if (config.keypair !== null) {
    lines.push(`  wallet        ${config.keypair.publicKey.toBase58()}`);
  }
  if (config.maxBidLamports !== null && config.dailyCapLamports !== null) {
    lines.push(
      `  limits        max bid ${lamportsToSol(config.maxBidLamports)} SOL, daily cap ${lamportsToSol(config.dailyCapLamports)} SOL (gross, rolling 24 h)`,
    );
  } else {
    lines.push('  limits        none needed (nothing can be signed)');
  }

  lines.push(`  rpc           ${rpcHost(config.rpcUrl)}`);
  lines.push(`  billboard     ${BILLBOARD_ADDRESS.toBase58()} (PDA verified)`);
  lines.push(
    `  subscription  ${input.subscribed ? 'account changes via websocket' : config.keypair === null ? 'not started (read-only)' : 'unavailable, state is fetched on each read'}`,
  );
  lines.push(`  activity log  ${config.activityLogPath}`);

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

async function serve(): Promise<void> {
  // Refuse to start if the constants and the derivation disagree: every
  // transaction the server ever builds targets this address.
  deriveBillboardPda();

  const config = loadConfig();
  const rpc = new SolanaRpc({ rpcUrl: config.rpcUrl, wsUrl: config.rpcWsUrl });
  const context = createContext(config, rpc);
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
    case 'error':
      stderr(`${PACKAGE_NAME}: ${command.message}`);
      stderr(`Run '${PACKAGE_NAME} --help' for usage.`);
      process.exitCode = 2;
      return;
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
