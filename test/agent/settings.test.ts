import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TOOLS,
  DENIED_BUILTIN_TOOLS,
  MCP_SERVER_KEY,
  agentPlatform,
  claudeSettings,
  mcpConfig,
  toJsonFile,
} from '../../src/agent/settings.js';
import { PACKAGE_VERSION } from '../../src/version.js';

/** The built-ins Claude Code 2.1.280 reported in an init event (fleet ISOLATION.md #4, R0). */
const BUILTINS_2_1_280 = [
  'Task',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'DesignSync',
  'Edit',
  'EnterWorktree',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListAgents',
  'Monitor',
  'NotebookEdit',
  'PowerShell',
  'PushNotification',
  'Read',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendMessage',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskUpdate',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
];

describe('tool lists', () => {
  it('allows exactly the three billboard tools a wake needs, in order', () => {
    expect([...ALLOWED_TOOLS]).toEqual([
      'mcp__agent-billboard__read_billboard',
      'mcp__agent-billboard__get_flip_history',
      'mcp__agent-billboard__acquire_posting_rights',
    ]);
    expect(MCP_SERVER_KEY).toBe('agent-billboard');
  });

  it('denies 52 built-ins, sorted, covering every 2.1.280 built-in', () => {
    expect(DENIED_BUILTIN_TOOLS).toHaveLength(52);
    expect([...DENIED_BUILTIN_TOOLS]).toEqual([...DENIED_BUILTIN_TOOLS].sort());
    expect(new Set(DENIED_BUILTIN_TOOLS).size).toBe(52);
    for (const name of BUILTINS_2_1_280) expect(DENIED_BUILTIN_TOOLS).toContain(name);
    for (const name of ['WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'Glob', 'Grep']) {
      expect(DENIED_BUILTIN_TOOLS).toContain(name);
    }
  });

  it('never allows or denies the other billboard tools (a person in propose mode is asked)', () => {
    const all: string[] = [...ALLOWED_TOOLS, ...DENIED_BUILTIN_TOOLS];
    for (const tool of ['approve_proposal', 'append_message', 'clear_message']) {
      expect(all.some((name) => name.includes(tool))).toBe(false);
    }
    expect(DENIED_BUILTIN_TOOLS.some((name) => name.startsWith('mcp__'))).toBe(false);
  });
});

describe('claudeSettings', () => {
  it('writes the allow and deny lists and nothing else', () => {
    const settings = claudeSettings();
    expect(Object.keys(settings)).toEqual(['permissions']);
    expect(settings.permissions.allow).toEqual([...ALLOWED_TOOLS]);
    expect(settings.permissions.deny).toEqual([...DENIED_BUILTIN_TOOLS]);
    expect(settings.permissions.allow).not.toBe(ALLOWED_TOOLS);
  });
});

describe('mcpConfig', () => {
  it('maps the host platform', () => {
    expect(agentPlatform('win32')).toBe('win32');
    expect(agentPlatform('linux')).toBe('posix');
    expect(agentPlatform('darwin')).toBe('posix');
  });

  it('POSIX: npx pinned to the version, no env block', () => {
    expect(mcpConfig({ platform: 'posix', version: '9.8.7' })).toEqual({
      mcpServers: {
        'agent-billboard': { command: 'npx', args: ['-y', 'agent-billboard-mcp@9.8.7'] },
      },
    });
  });

  it('Windows: cmd /c npx pinned to the version, no env block', () => {
    expect(mcpConfig({ platform: 'win32', version: '9.8.7' })).toEqual({
      mcpServers: {
        'agent-billboard': {
          command: 'cmd',
          args: ['/c', 'npx', '-y', 'agent-billboard-mcp@9.8.7'],
        },
      },
    });
  });

  it('sandbox twin sets only BILLBOARD_SANDBOX=true, on both platforms', () => {
    for (const platform of ['posix', 'win32'] as const) {
      const entry = mcpConfig({ platform, version: '1.0.0', sandbox: true }).mcpServers[
        'agent-billboard'
      ];
      expect(entry?.env).toEqual({ BILLBOARD_SANDBOX: 'true' });
      expect(entry?.args.at(-1)).toBe('agent-billboard-mcp@1.0.0');
    }
    expect(
      mcpConfig({ platform: 'posix', sandbox: false }).mcpServers['agent-billboard'],
    ).not.toHaveProperty('env');
  });

  it('pins to PACKAGE_VERSION by default', () => {
    const entry = mcpConfig({ platform: 'posix' }).mcpServers['agent-billboard'];
    expect(entry?.args).toEqual(['-y', `agent-billboard-mcp@${PACKAGE_VERSION}`]);
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('toJsonFile is pretty JSON with a trailing newline', () => {
    const text = toJsonFile(mcpConfig({ platform: 'posix', version: '1.0.0' }));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "mcpServers": {');
    expect(JSON.parse(text)).toEqual(mcpConfig({ platform: 'posix', version: '1.0.0' }));
  });
});
