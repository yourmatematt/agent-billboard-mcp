/**
 * The package version, read from `package.json` at load time so the MCP
 * `initialize` response, `--version` and the start-up banner can never
 * drift from what npm publishes.
 *
 * Resolved relative to this module: `src/version.ts` and `dist/version.js`
 * both sit one level below the package root.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'agent-billboard-mcp';

function readPackageVersion(): string {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version;
    }
  } catch {
    // Fall through: an unreadable package.json is not worth refusing to start over.
  }
  return '0.0.0';
}

export const PACKAGE_VERSION: string = readPackageVersion();
