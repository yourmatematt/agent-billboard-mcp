/**
 * The Claude Code files an agent folder carries: `.mcp.json` (and the
 * sandbox twin `run --sandbox` passes instead), and `.claude/settings.json`,
 * which locks the folder to the billboard's read and bid tools.
 *
 * Rules:
 *   - `.mcp.json` starts the server pinned to this package's own version,
 *     with no `env` block: the server reads the folder's `.env` itself, so no
 *     limit or keypair path is ever copied into a second file.
 *   - On Windows the command is `cmd /c npx ...`, because Claude Code spawns
 *     MCP servers without a shell and `npx` there is a `.cmd` shim.
 *   - The deny list names every built-in tool Claude Code is known to have
 *     (R0's list: the 31 that 2.1.280 reports, plus names older or newer
 *     builds use). The allow list is the three billboard tools a wake needs.
 *     `append_message`, `clear_message` and `approve_proposal` are in neither:
 *     a wake never allows them, and a person in propose mode is asked every
 *     time, which is the point of propose mode.
 *   - Everything here is a pure function of its inputs. The platform is
 *     injected so both shapes are tested on any host.
 */
import { PACKAGE_NAME, PACKAGE_VERSION } from '../version.js';

/** The server key in `.mcp.json`. Tool names follow from it: `mcp__<key>__<tool>`. */
export const MCP_SERVER_KEY = 'agent-billboard';

/** The only tools a wake may call, in the order `--allowedTools` lists them. */
export const ALLOWED_TOOLS = [
  `mcp__${MCP_SERVER_KEY}__read_billboard`,
  `mcp__${MCP_SERVER_KEY}__get_flip_history`,
  `mcp__${MCP_SERVER_KEY}__acquire_posting_rights`,
] as const;

/**
 * Every built-in Claude Code tool, denied by name in `.claude/settings.json`.
 * Sorted; pinned by a test. `--tools ""` already removes the built-ins from a
 * wake; this list keeps them out of a person's own session in the folder too.
 */
export const DENIED_BUILTIN_TOOLS = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'BashOutput',
  'CronCreate',
  'CronDelete',
  'CronList',
  'DesignSync',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'KillBash',
  'KillShell',
  'LS',
  'LSP',
  'ListAgents',
  'ListMcpResourcesTool',
  'Monitor',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'PowerShell',
  'PushNotification',
  'REPL',
  'Read',
  'ReadMcpResourceDirTool',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendMessage',
  'SendUserMessage',
  'Skill',
  'SlashCommand',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoRead',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
] as const;

/** The two platform shapes that matter for spawning `npx`. */
export type AgentPlatform = 'win32' | 'posix';

/** Maps `process.platform` to the shape `.mcp.json` needs. */
export function agentPlatform(platform: NodeJS.Platform = process.platform): AgentPlatform {
  return platform === 'win32' ? 'win32' : 'posix';
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

export interface McpConfigOptions {
  platform?: AgentPlatform;
  /** The package version to pin. Default: this package's own. */
  version?: string;
  /** True for `.mcp.sandbox.json`: the server starts with `BILLBOARD_SANDBOX=true`. */
  sandbox?: boolean;
}

/** The `.mcp.json` (or `.mcp.sandbox.json`) object for an agent folder. */
export function mcpConfig(options: McpConfigOptions = {}): McpConfig {
  const platform = options.platform ?? agentPlatform();
  const spec = `${PACKAGE_NAME}@${options.version ?? PACKAGE_VERSION}`;
  const entry: McpServerEntry =
    platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'npx', '-y', spec] }
      : { command: 'npx', args: ['-y', spec] };
  if (options.sandbox === true) entry.env = { BILLBOARD_SANDBOX: 'true' };
  return { mcpServers: { [MCP_SERVER_KEY]: entry } };
}

export interface ClaudeSettings {
  permissions: {
    allow: string[];
    deny: string[];
  };
}

/** The `.claude/settings.json` object for an agent folder. */
export function claudeSettings(): ClaudeSettings {
  return {
    permissions: {
      allow: [...ALLOWED_TOOLS],
      deny: [...DENIED_BUILTIN_TOOLS],
    },
  };
}

/** Pretty JSON with a trailing newline, the form every generated file uses. */
export function toJsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
