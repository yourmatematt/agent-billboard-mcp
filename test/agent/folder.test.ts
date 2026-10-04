import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { parse as parseDotenv } from 'dotenv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_ENV_KEYS,
  AGENT_GITIGNORE_LINES,
  AGENT_SETTINGS_DEFAULTS,
  AgentFolderError,
  agentEnvValues,
  agentPaths,
  agentSettingsFile,
  claudeMdWarning,
  findClaudeMdFiles,
  formatEnvValue,
  parseAgentSettings,
  readAgentSettings,
  readEnvFile,
  updateEnvText,
  updateGitignoreText,
  writeEnvFile,
  writeFileAtomic,
} from '../../src/agent/folder.js';
import { loadConfig } from '../../src/config.js';
import { solToLamports } from '../../src/program/math.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-folder-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('agentPaths', () => {
  it('resolves every file against the folder', () => {
    const p = agentPaths('agent', dir);
    expect(p.dir).toBe(resolve(dir, 'agent'));
    expect(p.intent).toBe(join(p.dir, 'intent.md'));
    expect(p.env).toBe(join(p.dir, '.env'));
    expect(p.keypair).toBe(join(p.dir, 'wallet.keypair.json'));
    expect(p.agentJson).toBe(join(p.dir, 'agent.json'));
    expect(p.mcpJson).toBe(join(p.dir, '.mcp.json'));
    expect(p.mcpSandboxJson).toBe(join(p.dir, '.mcp.sandbox.json'));
    expect(p.settings).toBe(join(p.dir, '.claude', 'settings.json'));
    expect(p.gitignore).toBe(join(p.dir, '.gitignore'));
    expect(p.runnerState).toBe(join(p.dir, 'runner-state.json'));
    expect(p.runnerLog).toBe(join(p.dir, 'logs', 'runner.log'));
    expect(p.wakeLog).toBe(join(p.dir, 'logs', 'wake.log'));
    expect(p.wakes).toBe(join(p.dir, 'logs', 'wakes'));
    expect(p.pause).toBe(join(p.dir, 'PAUSE'));
    expect(p.activityLog).toBe(join(p.dir, 'billboard-activity.jsonl'));
    expect(p.sandboxActivityLog).toBe(join(p.dir, 'billboard-sandbox-activity.jsonl'));
  });

  it('keeps an absolute folder as given', () => {
    expect(agentPaths(dir, '/elsewhere').dir).toBe(resolve(dir));
  });
});

describe('writeFileAtomic', () => {
  it('creates parent folders, replaces the file and leaves no temp file', () => {
    const target = join(dir, 'a', 'b', 'file.json');
    writeFileAtomic(target, 'one\n');
    writeFileAtomic(target, 'two\n');
    expect(readFileSync(target, 'utf8')).toBe('two\n');
    expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['file.json']);
  });
});

describe('agent.json', () => {
  it('has the locked defaults', () => {
    expect(AGENT_SETTINGS_DEFAULTS).toEqual({
      model: null,
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
      rpc_url: 'https://api.mainnet-beta.solana.com',
    });
  });

  it('a missing file is every default; a partial file fills in the rest', () => {
    expect(readAgentSettings(join(dir, 'agent.json'))).toEqual(AGENT_SETTINGS_DEFAULTS);
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({ model: 'claude-haiku-4-5', max_wakes_24h: 3 }),
    );
    expect(readAgentSettings(join(dir, 'agent.json'))).toEqual({
      ...AGENT_SETTINGS_DEFAULTS,
      model: 'claude-haiku-4-5',
      max_wakes_24h: 3,
    });
  });

  it('agentSettingsFile writes every key in the default order and round-trips', () => {
    const text = agentSettingsFile({ model: 'claude-sonnet-5' });
    expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(AGENT_SETTINGS_DEFAULTS));
    expect(text.endsWith('\n')).toBe(true);
    writeFileSync(join(dir, 'agent.json'), text);
    expect(readAgentSettings(join(dir, 'agent.json')).model).toBe('claude-sonnet-5');
    expect(JSON.parse(agentSettingsFile())).toEqual(AGENT_SETTINGS_DEFAULTS);
  });

  it('an unknown key is an error naming it', () => {
    expect(() => parseAgentSettings({ react_min_mins: 5 })).toThrow(AgentFolderError);
    expect(() => parseAgentSettings({ react_min_mins: 5 })).toThrow(
      /unknown setting: react_min_mins/,
    );
  });

  it('rejects bad values, naming the key', () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ react_min_min: 0 }, /react_min_min/],
      [{ react_min_min: 90 }, /react_min_min: must not be above react_max_min/],
      [{ next_look_min_h: 30 }, /next_look_min_h: must not be above next_look_max_h/],
      [{ poll_min_s: 500 }, /poll_min_s: must not be above poll_max_s/],
      [{ max_wakes_24h: 2.5 }, /max_wakes_24h/],
      [{ max_turns: 0 }, /max_turns/],
      [{ wake_timeout_min: -1 }, /wake_timeout_min/],
      [{ min_gap_min: '30' }, /min_gap_min/],
      [{ model: '' }, /model: must be a model id or null/],
      [{ rpc_url: 'ftp://x' }, /rpc_url: must be an http or https URL/],
      [{ rpc_url: 'not a url' }, /rpc_url/],
    ];
    for (const [value, message] of bad) {
      expect(() => parseAgentSettings(value), JSON.stringify(value)).toThrow(message);
    }
    expect(parseAgentSettings({ min_gap_min: 0, first_wake_max_min: 0 }).min_gap_min).toBe(0);
  });

  it('invalid JSON is an error naming the file', () => {
    const path = join(dir, 'agent.json');
    writeFileSync(path, '{ nope');
    expect(() => readAgentSettings(path)).toThrow(/agent\.json is not valid JSON/);
  });
});

describe('.env', () => {
  const input = {
    keypairPath: 'C:\\Users\\op\\new agent\\wallet.keypair.json',
    maxBidSol: '0.2',
    dailyCapSol: '0.4',
    autoBid: true,
  };

  it('a fresh file has a header and the five keys in order, and dotenv reads them back', () => {
    const text = updateEnvText(null, agentEnvValues(input));
    const keys = text
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.split('=')[0]);
    expect(keys).toEqual([...AGENT_ENV_KEYS]);
    expect(text.startsWith('# ')).toBe(true);
    expect(parseDotenv(text)).toEqual({
      BILLBOARD_KEYPAIR: input.keypairPath,
      MAX_BID_SOL: '0.2',
      DAILY_CAP_SOL: '0.4',
      AUTO_BID: 'true',
      INTENT_PATH: './intent.md',
    });
  });

  it('keeps unknown keys and comments, replaces in place, appends what is missing', () => {
    const existing = [
      '# mine',
      'RPC_URL=https://my.rpc.example',
      'MAX_BID_SOL=0.1',
      'export AUTO_BID=false',
      'HISTORY_URL="https://h.example"',
      '',
    ].join('\r\n');
    const text = updateEnvText(existing, {
      MAX_BID_SOL: '0.3',
      AUTO_BID: 'true',
      DAILY_CAP_SOL: '0.6',
    });
    expect(text).toBe(
      [
        '# mine',
        'RPC_URL=https://my.rpc.example',
        'MAX_BID_SOL=0.3',
        'AUTO_BID=true',
        'HISTORY_URL="https://h.example"',
        'DAILY_CAP_SOL=0.6',
        '',
      ].join('\n'),
    );
  });

  it('drops later duplicates and multi-line quoted values of a key it sets', () => {
    const existing = "MAX_BID_SOL=0.1\nNOTE='line one\nline two'\nX=1\nMAX_BID_SOL=0.9\n";
    const text = updateEnvText(existing, { MAX_BID_SOL: '0.2', NOTE: 'short' });
    expect(text).toBe('MAX_BID_SOL=0.2\nNOTE=short\nX=1\n');
    expect(parseDotenv(text)).toEqual({ MAX_BID_SOL: '0.2', NOTE: 'short', X: '1' });
  });

  it('quotes only when needed and every value survives dotenv', () => {
    const values = [
      '0.25',
      'true',
      './intent.md',
      '/home/op/agent/wallet.keypair.json',
      'C:\\new\\temp\\wallet.keypair.json',
      'C:\\Users\\op\\my agent\\wallet.keypair.json',
      'has # hash',
      "it's here",
      `both ' and "`,
      `all ' " and \\n`,
    ];
    for (const value of values) {
      const text = updateEnvText(null, { K: value });
      expect(parseDotenv(text).K, value).toBe(value);
    }
    expect(formatEnvValue('0.25')).toBe('0.25');
    expect(formatEnvValue('C:\\x')).toBe("'C:\\x'");
    expect(() => formatEnvValue('a\nb')).toThrow(/newline/);
    expect(() => updateEnvText(null, { 'BAD KEY': '1' })).toThrow(/not a valid \.env key/);
  });

  it('readEnvFile: missing is empty; writeEnvFile keeps what it does not set', () => {
    const path = join(dir, '.env');
    expect(readEnvFile(path)).toEqual({});
    writeFileSync(path, 'CUSTOM=keep me\nMAX_BID_SOL=0.1\n');
    writeEnvFile(path, { MAX_BID_SOL: '0.5' });
    expect(readEnvFile(path)).toEqual({ CUSTOM: 'keep me', MAX_BID_SOL: '0.5' });
    expect(readdirSync(dir)).toEqual(['.env']);
  });

  it('the server loads a folder written this way: auto mode, the limits, the keypair', () => {
    const folder = join(dir, 'my agent #1');
    mkdirSync(folder);
    const kp = Keypair.generate();
    const keypairPath = join(folder, 'wallet.keypair.json');
    writeFileSync(keypairPath, JSON.stringify(Array.from(kp.secretKey)));
    writeEnvFile(join(folder, '.env'), agentEnvValues({ ...input, keypairPath }));

    const config = loadConfig({}, { cwd: folder });
    expect(config.mode).toBe('auto');
    expect(config.keypair?.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(config.maxBidLamports).toBe(solToLamports('0.2'));
    expect(config.dailyCapLamports).toBe(solToLamports('0.4'));
    expect(config.intentPath).toBe(join(folder, 'intent.md'));
  });
});

describe('.gitignore', () => {
  it('a fresh file holds exactly the agent lines', () => {
    expect(updateGitignoreText(null)).toBe(`${AGENT_GITIGNORE_LINES.join('\n')}\n`);
    expect([...AGENT_GITIGNORE_LINES]).toEqual([
      '.env',
      '*.keypair.json',
      '*.jsonl',
      'billboard-state.json',
      'runner-state.json',
      'logs/',
    ]);
  });

  it('keeps existing lines, appends only what is missing, and is idempotent', () => {
    const existing = 'node_modules/\r\n.env\nlogs/';
    const once = updateGitignoreText(existing);
    expect(once).toBe(
      'node_modules/\n.env\nlogs/\n*.keypair.json\n*.jsonl\nbillboard-state.json\nrunner-state.json\n',
    );
    expect(updateGitignoreText(once)).toBe(once);
  });

  it('never hides a file the operator edits', () => {
    // None of the patterns is a wildcard over md or json files the folder keeps.
    for (const line of AGENT_GITIGNORE_LINES) {
      expect(['intent.md', 'agent.json', '.mcp.json', '.gitignore']).not.toContain(line);
      expect(line).not.toMatch(/^\*\.(md|json)$/);
    }
  });
});

describe('CLAUDE.md check', () => {
  it('finds CLAUDE.md, CLAUDE.local.md and .claude/CLAUDE.md in the folder and every ancestor, nearest first', () => {
    const root = resolve('/r');
    const agent = join(root, 'a', 'b', 'agent');
    const present = new Set([
      join(root, 'CLAUDE.md'),
      join(root, 'a', '.claude', 'CLAUDE.md'),
      join(agent, 'CLAUDE.local.md'),
    ]);
    expect(findClaudeMdFiles(agent, (p) => present.has(p))).toEqual([
      join(agent, 'CLAUDE.local.md'),
      join(root, 'a', '.claude', 'CLAUDE.md'),
      join(root, 'CLAUDE.md'),
    ]);
    expect(findClaudeMdFiles(agent, () => false)).toEqual([]);
  });

  it('works on the real filesystem, for a folder that does not exist yet', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# not for agents');
    const found = findClaudeMdFiles(join(dir, 'not-yet', 'agent'));
    expect(found).toContain(join(dir, 'CLAUDE.md'));
    expect(existsSync(join(dir, 'not-yet'))).toBe(false);
  });

  it('warns in the locked words', () => {
    expect(claudeMdWarning('/x/CLAUDE.md')).toBe(
      "A CLAUDE.md at /x/CLAUDE.md would be loaded into your agent's context. Move the folder or remove that file.",
    );
  });
});
