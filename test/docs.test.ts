/**
 * The 0.5.0 docs and version files agree with each other and with the code:
 * one version everywhere, every doc the README links to is published, and the
 * new pages keep to the billboard's vocabulary.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { helpText } from '../src/cli.js';
import { AGENT_SETTINGS_DEFAULTS } from '../src/agent/folder.js';
import { DENIED_BUILTIN_TOOLS } from '../src/agent/settings.js';
import { PACKAGE_VERSION } from '../src/version.js';

const root = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string): string => readFileSync(root(path), 'utf8');
const json = (path: string): Record<string, unknown> =>
  JSON.parse(read(path)) as Record<string, unknown>;

const NEW_DOCS = ['docs/RUN.md', 'docs/DEMO-RUN.md'] as const;

/** The README's new top section, up to the next `## ` heading. */
function readmeTopSection(): string {
  const readme = read('README.md');
  const start = readme.indexOf('## Give your agent a belief and a budget');
  expect(start).toBeGreaterThan(-1);
  const end = readme.indexOf('\n## ', start + 3);
  return readme.slice(start, end);
}

describe('0.5.0 version and docs', () => {
  it('carries one version in package.json, both places in server.json and src/version.ts', () => {
    const pkg = json('package.json');
    const server = json('server.json') as { version: string; packages: { version: string }[] };
    expect(pkg.version).toBe('0.5.0');
    expect(server.version).toBe(pkg.version);
    expect(server.packages.map((p) => p.version)).toEqual([pkg.version]);
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(read('CHANGELOG.md')).toMatch(/^# Changelog\n\n## 0\.5\.0 — /);
  });

  it('publishes the new docs the README links to', () => {
    const files = json('package.json').files as string[];
    const readme = read('README.md');
    for (const doc of NEW_DOCS) {
      expect(files).toContain(doc);
      expect(read(doc).length).toBeGreaterThan(0);
    }
    expect(readme).toContain('](docs/RUN.md)');
  });

  it('opens the README with the three commands and what they cost', () => {
    const readme = read('README.md');
    expect(readme.indexOf('## Give your agent a belief and a budget')).toBeLessThan(
      readme.indexOf('## See the board without installing anything'),
    );
    const section = readmeTopSection();
    for (const command of ['init', 'run', 'report']) {
      expect(section).toContain(`npx agent-billboard-mcp ${command}`);
    }
    expect(section).toContain('your own Claude Code usage');
    expect(section).toContain('half the increase');
  });

  it('lists the commands in --help', () => {
    const help = helpText();
    expect(help).toContain(`agent-billboard-mcp ${PACKAGE_VERSION}`);
    for (const command of ['init [dir]', 'run [dir]', 'report [dir]']) {
      expect(help).toContain(command);
    }
  });

  it('points SKILL.md and docs/RUNTIMES.md at run', () => {
    expect(read('SKILL.md')).toContain('npx agent-billboard-mcp run');
    const runtimes = read('docs/RUNTIMES.md');
    const claudeCode = runtimes.slice(runtimes.indexOf('## Claude Code on a schedule'));
    expect(claudeCode).toContain('npx agent-billboard-mcp run');
    expect(claudeCode).toContain('](RUN.md)');
  });

  it('states the round-two numbers and the honest limits in docs/RUN.md', () => {
    const run = read('docs/RUN.md');
    expect(run).toContain('woke 189\ntimes. 134 of those wakes');
    expect(run).toContain('35 more came after the round was over');
    expect(run).toContain('fictional personas, ten wallets we funded');
    expect(run).toContain('**It uses your Claude account.**');
    expect(run).toContain('**It runs only while your machine is on.**');
    expect(run).toContain("**The board's price only rises.**");
    expect(run).toContain('PAUSE');
  });

  it('documents the agent.json defaults and the deny-list size the code uses', () => {
    const run = read('docs/RUN.md');
    for (const [key, value] of Object.entries(AGENT_SETTINGS_DEFAULTS)) {
      const shown = value === null ? 'null' : String(value);
      expect(run, key).toMatch(new RegExp(`\\| \`${key}\`\\s+\\| \`${shown}\``));
    }
    expect(run).toContain(`denies ${DENIED_BUILTIN_TOOLS.length}\n  built-in tool names`);
  });

  it('keeps the recording script off the keypair and .env', () => {
    const demo = read('docs/DEMO-RUN.md');
    const offScreen = demo.slice(demo.indexOf('## Keep off screen'), demo.indexOf('## Before'));
    expect(offScreen).toContain('`wallet.keypair.json`');
    expect(offScreen).toContain('`.env`');
    expect(demo).not.toMatch(/\bcat\s+(wallet\.keypair\.json|\.env)\b/);
  });

  it('uses the billboard vocabulary and none of the banned words in the new docs', () => {
    const text = [...NEW_DOCS.map(read), readmeTopSection()].join('\n');
    for (const banned of [
      /\bslots?\b/i,
      /\btook\b/i,
      /\bgrabbed\b/i,
      /\bwon\b/i,
      /\bowns\b/i,
      /revolutionary|game-changing|seamless|next-generation|cutting-edge|groundbreaking|marketplace/i,
    ]) {
      expect(text, String(banned)).not.toMatch(banned);
    }
  });
});
