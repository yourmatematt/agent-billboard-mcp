import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { MockRpc } from '../src/rpc/MockRpc.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-smoke-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('smoke', () => {
  it('server module imports and builds an McpServer on a mock RPC', async () => {
    const mod = await import('../src/server.js');
    expect(mod.SERVER_NAME).toBe('agent-billboard-mcp');
    const config = loadConfig({}, { cwd: dir, dotenvPath: null });
    const context = mod.createContext(config, new MockRpc());
    expect(context.limits).toBeNull();
    const server = mod.createServer(context);
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });
});
