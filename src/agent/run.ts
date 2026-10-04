/**
 * `agent-billboard-mcp run [dir]`: the runner (runner.ts) and the wake
 * (wake.ts) put together, with the refusals, the console and Ctrl+C.
 *
 * Modes:
 *   live       watches the real board (read-only RPC calls) and wakes the
 *              operator's own Claude Code when a trigger is due, the gate
 *              passes and the rails allow it. Needs AUTO_BID=true.
 *   --once     one wake now (fresh read, then the gate; the rails are not
 *              applied because the operator chose this wake), then exit.
 *   --sandbox  one rehearsal wake (implies --once) with `.mcp.sandbox.json`,
 *              which starts the server with BILLBOARD_SANDBOX=true. No RPC
 *              call and no gate: the simulated board lives inside the model's
 *              own server. Works in propose mode too.
 *   --dry-run  everything but the wake: it reads the board, gates, logs
 *              `would_wake`, and never starts Claude Code.
 *
 * Refusals (exit 2, one plain sentence, nothing started): no .env; no
 * BILLBOARD_KEYPAIR or no MAX_BID_SOL; AUTO_BID not true; no .mcp.json;
 * claude not found. A sandbox run needs only the .mcp.json and claude.
 *
 * Every wake is a model call on the operator's own Claude Code login and
 * usage. Nothing here prints the keypair: it is loaded once to learn the
 * public key (the gate's "is this agent the poster" and the funding line).
 */
import { existsSync, readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';

import type { RunArgs } from '../cli.js';
import { ConfigError, DEFAULT_SANDBOX_MAX_BID_SOL, loadKeypair } from '../config.js';
import { lamportsToSol } from '../program/math.js';
import { SolanaRpc } from '../rpc/SolanaRpc.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../version.js';
import {
  AgentFolderError,
  agentPaths,
  readAgentSettings,
  readEnvFile,
  writeFileAtomic,
  type AgentPaths,
  type AgentSettings,
} from './folder.js';
import {
  Runner,
  limitsFromEnv,
  realSleep,
  runLoop,
  runOnce,
  type EnvLimits,
  type OnceResult,
  type RunnerLogEntry,
  type RunnerRpc,
  type Sleep,
  type Trigger,
} from './runner.js';
import { MCP_SERVER_KEY, toJsonFile, type McpConfig } from './settings.js';
import { resolveClaude, runWake, type ClaudeCommand, type WakeLogEntry } from './wake.js';

const MIN_MS = 60_000;

export class RunError extends Error {
  override readonly name = 'RunError';
  constructor(message: string) {
    super(message);
  }
}

/** The locked refusal for an agent that is not allowed to act on its own. */
export const PROPOSE_MODE_REFUSAL =
  'This agent is in propose mode. Open Claude Code in this folder and approve bids yourself, or set AUTO_BID=true in .env to let it act on its own.';

export interface RunIo {
  /** stdout, no newline added. */
  write: (text: string) => void;
  /** stderr, no newline added. */
  writeErr: (text: string) => void;
}

export interface RunDeps {
  io?: Partial<RunIo>;
  /** Directory `dir` and `--claude` resolve against. Default `process.cwd()`. */
  cwd?: string;
  /** The environment claude is found in and its child environment is built from. */
  env?: NodeJS.ProcessEnv;
  /** The board and balance reader. Default: a `SolanaRpc` on agent.json's `rpc_url`. */
  rpc?: RunnerRpc;
  /** Epoch ms. Default `Date.now`. */
  now?: () => number;
  random?: () => number;
  sleep?: Sleep;
  /** Stops the run (Ctrl+C). Default: SIGINT and SIGTERM. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

/** Local wall-clock `HH:MM` for an epoch ms or an ISO time. */
export function clockTime(t: number | string): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** `AbCd..WxYz` for a base58 key in a console line. */
export function shortKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 4)}..${key.slice(-4)}` : key;
}

const TRIGGER_LABEL: Record<Trigger, string> = {
  first: 'its first look',
  board_changed: 'the board changed',
  self_chosen: 'the next look it chose',
  manual: 'a one-off wake',
};

const RAIL_LABEL: Record<string, string> = {
  min_gap: 'the gap between wakes (min_gap_min in agent.json)',
  max_wakes_24h: 'the 24-hour wake limit (max_wakes_24h in agent.json)',
};

export type RunMode = 'live' | 'dry' | 'sandbox';

export interface ConsoleContext {
  /** This agent's wallet, base58. */
  wallet: string;
  mode: RunMode;
  once: boolean;
  /** The wake.log entry of the wake that just finished, if any. */
  lastWake?: WakeLogEntry | null;
}

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * The console line for one runner.log event, without the time, or null when
 * the event says nothing an operator needs on screen.
 */
export function consoleLine(entry: RunnerLogEntry, ctx: ConsoleContext): string | null {
  const who = (poster: unknown): string =>
    poster === ctx.wallet ? 'this agent' : poster ? shortKey(str(poster)) : 'nobody';
  const at = (field: unknown): string => clockTime(str(field));
  switch (entry.event) {
    case 'started':
      if (ctx.once) return null;
      if (entry.pending_reaction_at) {
        return `A wake is already scheduled for ${at(entry.pending_reaction_at)} (the board changed).`;
      }
      if (entry.first_wake_at) return `First look around ${at(entry.first_wake_at)}.`;
      if (entry.next_look_at) {
        return `Next look around ${at(entry.next_look_at)}, sooner if the board changes.`;
      }
      return 'Watching the board.';
    case 'board_recorded':
    case 'change_seen': {
      const lead = entry.event === 'change_seen' ? 'The board changed' : 'Board';
      if (entry.decode_error) {
        return `${lead}, but it could not be decoded: ${sentence(str(entry.decode_error))}`;
      }
      return `${lead}: ${str(entry.amount_sol)} SOL, posted by ${who(entry.poster)}.`;
    }
    case 'own_post_ignored':
      return "That is this agent's own post, so it is no reason to wake.";
    case 'reaction_scheduled':
      return `Wake scheduled for ${at(entry.at)} (the board changed).`;
    case 'reaction_kept':
      return `A wake is already scheduled for ${at(entry.at)}.`;
    case 'deferred':
      return `Wake held until ${at(entry.until)} by ${RAIL_LABEL[str(entry.reason)] ?? 'a rail'}.`;
    case 'paused':
      return 'Paused: there is a PAUSE file in the folder. No wakes until it is removed.';
    case 'resumed':
      return 'Resumed: the PAUSE file is gone.';
    case 'poll_error':
      return `Could not read the board (${str(entry.error)}). Trying again in ${str(entry.retry_in_s)} s.`;
    case 'balance_error':
      return `Could not read the wallet balance (${str(entry.error)}). Trying again in ${str(entry.retry_in_s)} s.`;
    case 'limits_invalid':
      return `No wake: ${str(entry.error)}. Fix .env; it is read again before every wake.`;
    case 'skipped_poster':
      return 'No wake: this agent is the poster right now.';
    case 'priced_out':
      return str(entry.message);
    case 'waiting_for_budget':
      return (
        `No wake yet: the minimum bid (${str(entry.minimum_sol)} SOL) does not fit in what is left of ` +
        `your 24-hour cap (${str(entry.spent_24h_sol)} of ${str(entry.daily_cap_sol)} SOL spent). ` +
        `Checking again at ${at(entry.until)}, when enough of the oldest spend leaves the window.`
      );
    case 'unfunded':
      return (
        `No wake: the wallet holds ${str(entry.balance_sol)} SOL and needs ${str(entry.needed_sol)} SOL ` +
        `(the minimum bid plus 0.01 SOL for fees). Send at least ${str(entry.shortfall_sol)} SOL to ${ctx.wallet}.`
      );
    case 'wake_started':
      return `Waking Claude Code (${TRIGGER_LABEL[entry.trigger as Trigger] ?? str(entry.trigger)}).`;
    case 'wake_finished': {
      if (entry.skipped) {
        const why = sentence(str(entry.error) || 'it never started');
        return ctx.once
          ? `Claude Code did not start: ${why}`
          : `Claude Code did not start: ${why} Trying again at ${at(entry.retry_at)}.`;
      }
      const wake = ctx.lastWake;
      const reason = str(entry.reason) || 'no reason given';
      let text = `${str(entry.decision) || 'missing'} - ${sentence(reason)}`;
      if (wake?.timed_out) text += ' (Stopped at the wake timeout.)';
      else if (wake?.stopped) text += ' (Stopped by Ctrl+C.)';
      else if (wake && wake.exit_code !== 0)
        text += ` (Claude Code exited with code ${str(wake.exit_code)}.)`;
      if (ctx.once) {
        return entry.next_look_hours
          ? `${text} It asked to look again in ${str(entry.next_look_hours)} h.`
          : text;
      }
      return `${text} Next look around ${at(entry.next_look_at)}.`;
    }
    case 'would_wake':
      return `Dry run: Claude Code would wake now (${TRIGGER_LABEL[entry.trigger as Trigger] ?? str(entry.trigger)}). Nothing was started.`;
    case 'next_look_defaulted':
      if (ctx.once) return null;
      return ctx.mode === 'dry'
        ? `Dry run: next look around ${at(entry.next_look_at)}.`
        : 'The reply had no usable NEXT_LOOK, so the runner picked a time 3 to 12 hours out.';
    case 'state_unreadable':
      return `Could not read ${str(entry.path)} (${str(entry.error)}); starting with fresh state.`;
    case 'runner_error':
      return `Runner error: ${sentence(str(entry.error))} Carrying on.`;
    case 'stopped':
      if (entry.reason === 'once') return null;
      return entry.reason === 'signal'
        ? 'Stopped. State saved.'
        : 'Stopped: the --minutes given are up. State saved.';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Getting ready (every refusal happens here, before anything starts)
// ---------------------------------------------------------------------------

interface Prepared {
  paths: AgentPaths;
  settings: AgentSettings;
  /** Base58; null in a sandbox run without a usable keypair (it is not needed there). */
  wallet: string | null;
  limits: EnvLimits | null;
  autoBid: boolean;
  claude: ClaudeCommand | null;
  model: string | null;
}

function refuse(message: string): never {
  throw new RunError(message);
}

function readEnv(paths: AgentPaths): Record<string, string> {
  try {
    return readEnvFile(paths.env);
  } catch (err) {
    if (err instanceof AgentFolderError) refuse(err.message);
    throw err;
  }
}

function walletOf(value: string, dir: string): string {
  try {
    return loadKeypair(value, dir).publicKey.toBase58();
  } catch (err) {
    if (err instanceof ConfigError) {
      refuse(
        `BILLBOARD_KEYPAIR in .env cannot be used: ${err.message.replace(/^BILLBOARD_KEYPAIR /, '')}`,
      );
    }
    throw err;
  }
}

function prepare(args: RunArgs, cwd: string, env: NodeJS.ProcessEnv): Prepared {
  const paths = agentPaths(args.dir, cwd);
  if (!existsSync(paths.dir)) refuse(`There is no folder at ${paths.dir}.`);
  const sandbox = args.sandbox;

  let dotenv: Record<string, string> = {};
  let wallet: string | null = null;
  let limits: EnvLimits | null = null;
  if (!sandbox) {
    if (!existsSync(paths.env)) {
      refuse(
        `There is no .env in ${paths.dir}. Set up an agent with '${PACKAGE_NAME} init' and run it from that folder.`,
      );
    }
    dotenv = readEnv(paths);
    const keypair = dotenv.BILLBOARD_KEYPAIR?.trim();
    if (!keypair) {
      refuse('There is no BILLBOARD_KEYPAIR in .env, so this agent has no wallet to act with.');
    }
    wallet = walletOf(keypair, paths.dir);
    if (!dotenv.MAX_BID_SOL?.trim()) {
      refuse(
        'There is no MAX_BID_SOL in .env, so this agent has no per-bid limit; set one in SOL.',
      );
    }
    try {
      limits = limitsFromEnv(dotenv, paths.dir);
    } catch (err) {
      refuse(sentence(err instanceof Error ? err.message : String(err)));
    }
  } else if (existsSync(paths.env)) {
    // Shown in the banner only; a sandbox wake never uses the real wallet.
    dotenv = readEnv(paths);
    const keypair = dotenv.BILLBOARD_KEYPAIR?.trim();
    if (keypair) {
      try {
        wallet = loadKeypair(keypair, paths.dir).publicKey.toBase58();
      } catch {
        wallet = null;
      }
    }
    try {
      limits = limitsFromEnv(dotenv, paths.dir);
    } catch {
      limits = null;
    }
  }
  const autoBid = (dotenv.AUTO_BID ?? '').trim().toLowerCase() === 'true';
  if (!sandbox && !autoBid) refuse(PROPOSE_MODE_REFUSAL);

  let settings: AgentSettings;
  try {
    settings = readAgentSettings(paths.agentJson);
  } catch (err) {
    if (err instanceof AgentFolderError) refuse(err.message);
    throw err;
  }
  if (!existsSync(paths.mcpJson)) {
    refuse(`There is no .mcp.json in ${paths.dir}; '${PACKAGE_NAME} init' writes it.`);
  }

  let claude: ClaudeCommand | null = null;
  if (!args.dryRun) {
    claude = resolveClaude({ explicit: args.claude, env, cwd });
    if (!claude) {
      const where = args.claude
        ? `at ${args.claude}`
        : 'on PATH (nor at CLAUDE_PATH, when that is set)';
      refuse(
        `Claude Code was not found ${where}; install it, or point --claude at the claude executable.`,
      );
    }
  }

  return {
    paths,
    settings,
    wallet,
    limits,
    autoBid,
    claude,
    model: args.model ?? settings.model ?? null,
  };
}

/**
 * Writes `.mcp.sandbox.json` beside `.mcp.json`: the same server entry, with
 * `BILLBOARD_SANDBOX=true` added to its environment. Only the billboard
 * server is carried over (a wake loads nothing else anyway).
 */
export function writeSandboxMcpConfig(paths: AgentPaths): McpConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.mcpJson, 'utf8'));
  } catch (err) {
    return refuse(
      `.mcp.json in ${paths.dir} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  const entry = (parsed as Partial<McpConfig> | null)?.mcpServers?.[MCP_SERVER_KEY];
  if (!entry || typeof entry.command !== 'string' || !Array.isArray(entry.args)) {
    return refuse(`.mcp.json in ${paths.dir} has no "${MCP_SERVER_KEY}" server to rehearse with.`);
  }
  const twin: McpConfig = {
    mcpServers: {
      [MCP_SERVER_KEY]: { ...entry, env: { ...(entry.env ?? {}), BILLBOARD_SANDBOX: 'true' } },
    },
  };
  writeFileAtomic(paths.mcpSandboxJson, toJsonFile(twin));
  return twin;
}

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

function bannerLines(args: RunArgs, ready: Prepared, mode: RunMode): string[] {
  const { limits } = ready;
  const modeText =
    mode === 'sandbox'
      ? ready.autoBid
        ? 'sandbox: one rehearsal wake on the simulated board; nothing touches mainnet'
        : 'sandbox (propose): one rehearsal wake on the simulated board; a wake can only propose a bid, never approve it'
      : mode === 'dry'
        ? 'dry run: reads the real board and decides when to wake, but never starts Claude Code'
        : args.once
          ? 'live (AUTO_BID=true): one wake now, then exit'
          : 'live (AUTO_BID=true): it bids by itself within your limits';
  const limitText = limits
    ? `max bid ${lamportsToSol(limits.maxBid)} SOL, daily cap ${lamportsToSol(limits.dailyCap)} SOL (rolling 24 h)` +
      (mode === 'sandbox' ? '' : ', read again from .env before every wake')
    : `the sandbox default (max bid ${DEFAULT_SANDBOX_MAX_BID_SOL} SOL)`;
  const lines = [
    `${PACKAGE_NAME} ${PACKAGE_VERSION} run`,
    `  folder   ${ready.paths.dir}`,
    `  wallet   ${
      mode === 'sandbox'
        ? 'a simulated one inside the sandbox server (your wallet is not used)'
        : (ready.wallet ?? '')
    }`,
    `  mode     ${modeText}`,
    `  limits   ${limitText}`,
    `  model    ${ready.model ?? 'Claude Code default'}`,
    `  claude   ${ready.claude ? ready.claude.path : 'not started in a dry run'}`,
  ];
  if (mode !== 'dry') {
    lines.push('Every wake is a model call on your own Claude Code login and usage.');
  }
  lines.push('Ctrl+C to stop.');
  return lines;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * Runs `run`. Returns the exit code: 0 done (including a one-off wake the
 * gate held back, which is an answer, not a failure), 1 a one-off wake that
 * could not happen or did not finish cleanly, 2 refused (nothing started).
 */
export async function runRun(args: RunArgs, deps: RunDeps = {}): Promise<number> {
  const io: RunIo = {
    write: deps.io?.write ?? ((text) => void process.stdout.write(text)),
    writeErr: deps.io?.writeErr ?? ((text) => void process.stderr.write(text)),
  };
  let ready: Prepared;
  try {
    ready = prepare(args, deps.cwd ?? process.cwd(), deps.env ?? process.env);
    if (args.sandbox) writeSandboxMcpConfig(ready.paths);
  } catch (err) {
    if (!(err instanceof RunError)) throw err;
    io.writeErr(`${PACKAGE_NAME}: run: ${err.message}\n`);
    io.writeErr(`Run '${PACKAGE_NAME} run --help' for usage.\n`);
    return 2;
  }

  const controller = deps.signal ? null : new AbortController();
  const signal = deps.signal ?? (controller as AbortController).signal;
  const onSignal = (): void => controller?.abort();
  if (controller) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  try {
    return await go(args, deps, io, ready, signal);
  } finally {
    if (controller) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }
}

/** A stand-in reader for the sandbox, which never reads the real board. */
const NO_NETWORK: RunnerRpc = {
  getAccount: () => Promise.reject(new Error('the sandbox makes no network call')),
  getBalance: () => Promise.reject(new Error('the sandbox makes no network call')),
};

async function go(
  args: RunArgs,
  deps: RunDeps,
  io: RunIo,
  ready: Prepared,
  signal: AbortSignal,
): Promise<number> {
  const line = (text = ''): void => io.write(`${text}\n`);
  const mode: RunMode = args.dryRun ? 'dry' : args.sandbox ? 'sandbox' : 'live';
  const now = deps.now ?? Date.now;
  const { paths, settings } = ready;
  // The runner needs a wallet for its own-post check; a sandbox run never reads the board.
  const wallet = ready.wallet ?? PublicKey.default.toBase58();

  for (const text of bannerLines(args, ready, mode)) line(text);

  let lastWake: WakeLogEntry | null = null;
  const ctx = (): ConsoleContext => ({ wallet, mode, once: args.once, lastWake });
  const rpc = deps.rpc ?? (args.sandbox ? NO_NETWORK : new SolanaRpc({ rpcUrl: settings.rpc_url }));

  const runner = new Runner({
    paths,
    settings,
    wallet,
    dryRun: args.dryRun,
    sandbox: args.sandbox,
    deps: {
      now,
      random: deps.random ?? Math.random,
      rpc,
      onEvent: (entry) => {
        const text = consoleLine(entry, ctx());
        if (text) line(`${clockTime(entry.ts)}  ${text}`);
      },
      wake: async (trigger) => {
        lastWake = null;
        if (!ready.claude) throw new Error('no claude to start');
        const result = await runWake({
          paths,
          trigger,
          claude: ready.claude,
          maxTurns: settings.max_turns,
          model: ready.model,
          timeoutMs: settings.wake_timeout_min * MIN_MS,
          sandbox: args.sandbox,
          env: deps.env ?? process.env,
          now,
          signal,
        });
        lastWake = result.entry;
        return result;
      },
    },
  });

  if (!args.once) {
    const endAt = args.minutes === null ? Infinity : now() + args.minutes * MIN_MS;
    await runLoop(runner, { sleep: deps.sleep ?? realSleep, endAt, signal });
    return 0;
  }

  const result = await runOnce(runner, { signal });
  return closeOnce(result, lastWake, args, line);
}

function closeOnce(
  result: OnceResult,
  wake: WakeLogEntry | null,
  args: RunArgs,
  line: (text: string) => void,
): number {
  const report = `${PACKAGE_NAME} report${args.sandbox ? ' --sandbox' : ''}`;
  switch (result) {
    case 'woke':
      if (args.dryRun) return 0;
      if (wake?.stopped) {
        line('Stopped by Ctrl+C. The wake was ended and logged.');
        return 0;
      }
      if (wake && (wake.exit_code !== 0 || wake.timed_out)) {
        line(`The wake did not finish cleanly. Its transcript is ${wake.transcript}.`);
        return 1;
      }
      line(`Done. The wake is in logs/wake.log; see the record with: ${report}`);
      return 0;
    case 'blocked':
      line('No wake: the agent cannot act right now (the line above says why).');
      return 0;
    case 'paused':
      line('No wake: there is a PAUSE file in the folder.');
      return 0;
    case 'unreadable':
      line('No wake: the board could not be read.');
      return 1;
    case 'not_started':
      return 1;
  }
}
