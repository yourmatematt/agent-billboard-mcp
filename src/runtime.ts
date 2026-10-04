/**
 * The RPC and context a configuration calls for.
 *
 * Lives in its own module so both the server (`cli.ts`) and the `init`
 * rehearsal (`agent/rehearse.ts`) can build a runtime without importing each
 * other. `cli.ts` re-exports `createRuntime`, so existing imports keep working.
 */
import type { Config } from './config.js';
import type { Rpc } from './rpc/Rpc.js';
import { SolanaRpc } from './rpc/SolanaRpc.js';
import { createSandboxRpc, sandboxFetch } from './sandbox.js';
import { createContext, type ServerContext } from './server.js';

/**
 * Builds the RPC the mode calls for and the context around it.
 *
 * This is the only place the sandbox is decided. In the sandbox it returns a
 * `MockRpc` seeded from the scenario and a context whose `fetch` refuses, so
 * a rehearsal makes no outbound request even when `HISTORY_URL` is set;
 * `SolanaRpc` is never constructed. Exported so tests can assert exactly that
 * without starting a transport.
 */
export async function createRuntime(config: Config): Promise<{ rpc: Rpc; context: ServerContext }> {
  if (config.sandbox) {
    const rpc = await createSandboxRpc(config.sandboxScenario);
    return { rpc, context: createContext(config, rpc, { fetch: sandboxFetch }) };
  }
  const rpc = new SolanaRpc({ rpcUrl: config.rpcUrl, wsUrl: config.rpcWsUrl });
  return { rpc, context: createContext(config, rpc) };
}
