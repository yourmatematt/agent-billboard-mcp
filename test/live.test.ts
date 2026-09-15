/**
 * Live read-only check against the real mainnet billboard.
 *
 * Skipped unless `LIVE=1` is set, because the default test run must pass
 * with no network. Reads the PDA over `RPC_URL` (or the default public
 * endpoint), proves the hand-written decoder agrees with what the program
 * actually stores, and prints the current poster, amount and message size to
 * stderr so a run leaves a record. Nothing here signs or sends anything.
 *
 *     LIVE=1 npx vitest run test/live.test.ts
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { BillboardReader } from '../src/billboard/reader.js';
import { DEFAULT_RPC_URL } from '../src/config.js';
import {
  BILLBOARD_ADDRESS,
  MESSAGE_SIZE,
  PROGRAM_ID,
  decodeBillboard,
  deriveBillboardPda,
} from '../src/program/layout.js';
import { lamportsToSol, minimumBid } from '../src/program/math.js';
import { SolanaRpc } from '../src/rpc/SolanaRpc.js';

const LIVE = process.env['LIVE'] === '1';
const RPC_URL = process.env['RPC_URL'] ?? DEFAULT_RPC_URL;
const LIVE_TIMEOUT_MS = 30_000;

function isValidPubkey(value: PublicKey): boolean {
  try {
    return new PublicKey(value.toBase58()).equals(value) && value.toBytes().length === 32;
  } catch {
    return false;
  }
}

describe.skipIf(!LIVE)('live mainnet read (LIVE=1)', () => {
  const rpc = new SolanaRpc({ rpcUrl: RPC_URL });

  it('the PDA derived from the seed is the documented billboard address', () => {
    const pda = deriveBillboardPda();
    expect(pda.address.equals(BILLBOARD_ADDRESS)).toBe(true);
    expect(PublicKey.isOnCurve(BILLBOARD_ADDRESS.toBytes())).toBe(false);
  });

  it(
    'reads and decodes the real account; the poster is a valid pubkey',
    async () => {
      const raw = await rpc.getAccount(BILLBOARD_ADDRESS);
      expect(raw, 'billboard account exists on mainnet').not.toBeNull();
      const state = decodeBillboard(raw as Buffer);

      expect(isValidPubkey(state.poster)).toBe(true);
      expect(isValidPubkey(state.creator)).toBe(true);
      expect(state.poster.equals(PROGRAM_ID)).toBe(false);
      expect(typeof state.amount).toBe('bigint');
      expect(state.amount >= 0n).toBe(true);
      expect(state.messageBytes).toBe(Buffer.byteLength(state.message, 'utf8'));
      expect(state.messageBytes).toBeLessThanOrEqual(MESSAGE_SIZE);

      const minimum = minimumBid(state.amount);
      expect(minimum > state.amount || state.amount === 0n).toBe(true);

      process.stderr.write(
        [
          `[live] rpc:           ${new URL(RPC_URL).host}`,
          `[live] poster:        ${state.poster.toBase58()}`,
          `[live] creator:       ${state.creator.toBase58()}`,
          `[live] amount:        ${lamportsToSol(state.amount)} SOL (${state.amount} lamports)`,
          `[live] minimum bid:   ${lamportsToSol(minimum)} SOL`,
          `[live] message bytes: ${state.messageBytes} of ${MESSAGE_SIZE}`,
          `[live] account bytes: ${(raw as Buffer).length}`,
          '',
        ].join('\n'),
      );
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'BillboardReader over SolanaRpc returns the same state without a wallet',
    async () => {
      const reader = new BillboardReader(rpc, { wallet: null, warn: () => undefined });
      const first = await reader.read();
      expect(first.youArePoster).toBe(false);
      expect(first.changedSinceLastRead).toBe(false);
      expect(first.fetchedAt).toBeInstanceOf(Date);
      expect(isValidPubkey(first.state.poster)).toBe(true);
      expect(first.state.messageBytes).toBeLessThanOrEqual(MESSAGE_SIZE);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'dist/cli.js with no env answers read_billboard over stdio and exits 0 when stdin closes',
    async () => {
      // Regression for the shutdown path: on Node 24 for Windows a
      // process.exit() straight after an HTTPS fetch tripped a libuv assertion
      // and the server died with a non-zero code. Shutdown now lets the loop
      // drain, so the exit must be 0 and stderr must carry no assertion.
      const cliPath = join(process.cwd(), 'dist', 'cli.js');
      const cwd = mkdtempSync(join(tmpdir(), 'abm-live-cli-'));
      const result = await driveReadOnlyCli(cliPath, cwd);

      expect(result.stderr).not.toMatch(/Assertion failed/);
      expect(result.code).toBe(0);
      expect(result.stdoutLines.length).toBe(3);
      for (const line of result.stdoutLines) {
        expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
      }
      const read = result.stdoutLines
        .map((line) => JSON.parse(line) as JsonRpcReply)
        .find((m) => m.id === 3);
      expect(read?.result?.isError).not.toBe(true);
      const structured = read?.result?.structuredContent;
      expect(isValidPubkey(new PublicKey(structured?.poster ?? ''))).toBe(true);
      expect(structured?.operator.limits.read_only).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );
});

interface JsonRpcReply {
  jsonrpc: string;
  id?: number;
  result?: {
    isError?: boolean;
    structuredContent?: { poster?: string; operator: { limits: { read_only: boolean } } };
  };
}

interface ReadOnlyCliResult {
  code: number | null;
  stdoutLines: string[];
  stderr: string;
}

/**
 * Starts `dist/cli.js` with only PATH in its environment, drives initialize,
 * tools/list and a `read_billboard` call over stdin, closes stdin once the
 * read has been answered, and resolves when the process exits.
 */
function driveReadOnlyCli(cliPath: string, cwd: string): Promise<ReadOnlyCliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath], {
      cwd,
      env: { PATH: process.env['PATH'] ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let ended = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cli did not finish within ${LIVE_TIMEOUT_MS} ms\nstderr:\n${stderr}`));
    }, LIVE_TIMEOUT_MS - 1000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (!ended && stdout.includes('"id":3')) {
        ended = true;
        child.stdin.end();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        stdoutLines: stdout.split(/\r?\n/).filter((line) => line.length > 0),
        stderr,
      });
    });
    const messages = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'live-cli-check', version: '0.0.0' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read_billboard', arguments: {} },
      },
    ];
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}
