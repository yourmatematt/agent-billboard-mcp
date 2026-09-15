/**
 * MCP server construction.
 *
 * Everything the tools need is bundled into a `ServerContext` built once
 * from the validated `Config` and an `Rpc`. Production (`cli.ts`) passes a
 * `SolanaRpc`; tests and the demo pass a `MockRpc`. Nothing in the tools
 * knows which one it has.
 *
 * Tools are registered one file at a time under `src/tools/`. Each exports a
 * `register*` function that takes the server and the context.
 *
 * Nothing here writes to stdout: that channel belongs to the MCP transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { BillboardReader } from './billboard/reader.js';
import type { Config } from './config.js';
import { ActivityLog } from './log/activity.js';
import { ProposalStore } from './proposals.js';
import type { Rpc } from './rpc/Rpc.js';
import { SpendLimits } from './spend/limits.js';
import { registerAcquirePostingRights } from './tools/acquire_posting_rights.js';
import { registerAppendMessage } from './tools/append_message.js';
import { registerApproveProposal } from './tools/approve_proposal.js';
import { registerClearMessage } from './tools/clear_message.js';
import { registerGetFlipHistory } from './tools/get_flip_history.js';
import { registerReadBillboard } from './tools/read_billboard.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';

export const SERVER_NAME = PACKAGE_NAME;
/** Read from package.json at load time (see `version.ts`). */
export const SERVER_VERSION = PACKAGE_VERSION;

export interface ServerContext {
  readonly config: Config;
  readonly rpc: Rpc;
  readonly activityLog: ActivityLog;
  readonly reader: BillboardReader;
  /** Null in read-only mode: there is nothing to limit when nothing can be signed. */
  readonly limits: SpendLimits | null;
  /** Pending proposals under AUTO_BID=false. Always present; empty in other modes. */
  readonly proposals: ProposalStore;
  /** Clock shared by every component. Injectable for tests. */
  readonly now: () => Date;
  /** Where human-readable warnings go. Default: stderr. */
  readonly warn: (message: string) => void;
  /** HTTP client for the optional HISTORY_URL. Injectable for tests. Default: global fetch. */
  readonly fetch: typeof globalThis.fetch;
}

export interface CreateContextOptions {
  now?: () => Date;
  warn?: (message: string) => void;
  fetch?: typeof globalThis.fetch;
}

/**
 * Builds the shared context: activity log, billboard reader and (in write
 * modes) the spend limiter, all on the same clock and warning sink.
 */
export function createContext(
  config: Config,
  rpc: Rpc,
  options: CreateContextOptions = {},
): ServerContext {
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const activityLog = new ActivityLog(config.activityLogPath, { now, warn });
  const reader = new BillboardReader(rpc, {
    wallet: config.keypair?.publicKey ?? null,
    activityLog,
    now,
    warn,
  });
  const limits =
    config.maxBidLamports !== null && config.dailyCapLamports !== null
      ? new SpendLimits(
          activityLog,
          { maxBidLamports: config.maxBidLamports, dailyCapLamports: config.dailyCapLamports },
          { now },
        )
      : null;
  const proposals = new ProposalStore({ activityLog, now, warn });
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return { config, rpc, activityLog, reader, limits, proposals, now, warn, fetch: fetchImpl };
}

/** Builds the MCP server with every tool registered against `context`. */
export function createServer(context: ServerContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerReadBillboard(server, context);
  registerAcquirePostingRights(server, context);
  registerAppendMessage(server, context);
  registerClearMessage(server, context);
  registerApproveProposal(server, context);
  registerGetFlipHistory(server, context);
  return server;
}
