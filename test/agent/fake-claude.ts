/**
 * Installs test/fixtures/fake-claude.mjs into a temp folder the way a real
 * `claude` is installed: a `claude.cmd` npm-style launcher on Windows, an
 * executable `claude` shell script elsewhere. The fake records its calls next
 * to itself, so each install has its own record.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveClaude, type ClaudeCommand } from '../../src/agent/wake.js';

export const FAKE_CLAUDE_SOURCE = fileURLToPath(
  new URL('../fixtures/fake-claude.mjs', import.meta.url),
);

export interface FakeCall {
  argv: string[];
  cwd: string;
  stdin: string;
  pid: number;
  envKeys: string[];
  switches: Record<string, string>;
}

export interface FakeClaude {
  /** The folder holding the launcher (put it on PATH to find it as `claude`). */
  binDir: string;
  /** The launcher, resolved the way `run` resolves `--claude`. */
  command: ClaudeCommand;
  calls(): FakeCall[];
}

export function installFakeClaude(root: string): FakeClaude {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(FAKE_CLAUDE_SOURCE, join(binDir, 'fake-claude.mjs'));
  let launcher: string;
  if (process.platform === 'win32') {
    launcher = join(binDir, 'claude.cmd');
    writeFileSync(
      launcher,
      `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`,
      'utf8',
    );
  } else {
    launcher = join(binDir, 'claude');
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.mjs" "$@"\n`,
      'utf8',
    );
    chmodSync(launcher, 0o755);
  }
  const command = resolveClaude({ explicit: launcher });
  if (!command) throw new Error(`the fake claude at ${launcher} did not resolve`);
  const record = join(binDir, 'fake-claude.calls.jsonl');
  return {
    binDir,
    command,
    calls: () =>
      existsSync(record)
        ? readFileSync(record, 'utf8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l) as FakeCall)
        : [],
  };
}
