/**
 * End-to-end demo on the mock RPC. No network, no keypair with funds.
 *
 * Runs the real MCP server over the SDK's in-memory transport against a
 * `MockRpc` seeded like mainnet (a previous holder at 0.1 SOL with a short
 * message), calls each tool in turn and prints every result. `npm run demo`
 * compiles this with `tsconfig.demo.json` and runs it; `test/e2e.test.ts`
 * (T18) imports `runDemo` directly.
 *
 * T13 shipped the skeleton (read, dry-run acquire, flip history); T17 added
 * the propose → approve steps and the activity-log printout that docs/DEMO.md
 * quotes. T18 completes the walk from the Definition of Done (append → outside
 * acquire → refused bid → history) and regenerates the README and DEMO.md
 * examples from this output.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import { loadConfig } from '../src/config.js';
import type { ActivityEntry } from '../src/log/activity.js';
import { lamportsToSol, solToLamports } from '../src/program/math.js';
import { MockRpc } from '../src/rpc/MockRpc.js';
import { createContext, createServer, type ServerContext } from '../src/server.js';
import { ACQUIRE_TOOL } from '../src/tools/acquire_posting_rights.js';
import { APPEND_TOOL } from '../src/tools/append_message.js';
import { APPROVE_TOOL } from '../src/tools/approve_proposal.js';
import { GET_FLIP_HISTORY_TOOL } from '../src/tools/get_flip_history.js';
import { READ_BILLBOARD_TOOL } from '../src/tools/read_billboard.js';

export interface DemoOptions {
  /** Where each printed line goes. Default: stdout. */
  out?: (line: string) => void;
  /** Where server warnings go. Default: stderr. */
  warn?: (line: string) => void;
  /** Intent file to load. Default: `intent.example.md` in the working directory. */
  intentPath?: string;
}

export interface DemoStep {
  tool: string;
  args: Record<string, unknown>;
  isError: boolean;
  text: string;
  structured: unknown;
}

export interface DemoResult {
  steps: DemoStep[];
  /** Every activity-log line the walk produced, in order. */
  activity: ActivityEntry[];
  /** Base58 public key of the demo wallet (a throwaway keypair, never funded). */
  wallet: string;
}

/** Demo limits. The README quotes these, so change both together. */
export const DEMO_ENV = {
  MAX_BID_SOL: '0.2',
  DAILY_CAP_SOL: '0.5',
  AUTO_BID: 'false',
} as const;

/** Fixed clock so `fetched_at` and `expires_at` are stable across runs: +1 s per tick. */
export const DEMO_START = new Date('2026-09-14T12:00:00.000Z');

const PREVIOUS_MESSAGE = 'gm. previous holder here. this slot cost 0.1 SOL.';

/** The one-line post from `intent.example.md`, well under its 300-byte ask. */
export const DEMO_MESSAGE =
  'Tall Poppy Bakes, Newcastle NSW. Sourdough, rye and a very good fruit loaf. Posted Australia-wide every Wednesday. tallpoppybakes.example';

/** Exactly 2 000 UTF-8 bytes: three chunks of 900, 900 and 200. */
export const DEMO_LONG_MESSAGE_BYTES = 2000;

/**
 * The follow-up post: the week's menu and ordering details, padded with a
 * dashed rule to exactly `DEMO_LONG_MESSAGE_BYTES` so the chunk counts in the
 * docs are provable. ASCII only, so bytes equal characters.
 */
export const DEMO_LONG_MESSAGE = buildLongMessage();

function buildLongMessage(): string {
  const body = [
    '',
    'This week at Tall Poppy Bakes (Hunter St, Newcastle NSW):',
    '- Country sourdough, 800 g: $9. Slow-fermented 24 h, no commercial yeast.',
    '- Seeded rye, 750 g: $10. Wholegrain rye with linseed and sunflower.',
    '- Fruit loaf, 700 g: $12. Sultanas, currants, candied peel, a little rum.',
    '- Olive and rosemary, 600 g: $9.',
    '- Hot cross buns, six: $14 (Easter fortnight only).',
    'Ordering: reply on the website form before 6 pm Tuesday for Wednesday dispatch.',
    'Shipping: flat $12 Australia-wide, express, packed the morning it leaves.',
    'Pickup: Wednesday to Saturday, 7 am to 2 pm, from the shop.',
    'Wholesale: cafes and grocers in the Hunter, minimum six loaves, weekly standing orders welcome.',
    'Allergens: all loaves contain wheat or rye gluten; nuts are not used in the bakery.',
    'Also this week: sourdough crumpets on Saturday morning until they run out, and day-old loaves at half price after 1 pm.',
    'Bread classes: the next beginner sourdough class is the last Sunday of the month, 9 am to 1 pm, $120 with a starter and a loaf to take home. Eight places.',
    'Starter: our rye starter is free to anyone who brings a clean jar. Ask at the counter.',
    'Flour: stoneground from a mill in the Riverina; the rye is from the Wimmera. Both are named on the bag we hand you.',
    'Freezing: every loaf freezes well sliced. Toast from frozen. The fruit loaf is best warmed.',
    'Hours over the long weekend: closed Monday, open as usual from Wednesday.',
    'Gift boxes: two loaves, a jar of cultured butter and a tea towel, $45 delivered in the Hunter, $57 elsewhere. Order by the Friday before.',
    'Markets: Olive Tree Market on the first Saturday of the month and Newcastle City Farmers Market every Sunday, 8 am until sold out.',
    'Questions, wholesale enquiries and gift orders: use the form on the website. Replies within one working day.',
    'This slot was bought at the minimum bid and will be kept while it earns its keep.',
    'If you take it from us, the program refunds the bid plus half your increase; no hard feelings.',
    '',
  ].join('\n');
  const used = Buffer.byteLength(body, 'utf8');
  if (used >= DEMO_LONG_MESSAGE_BYTES) {
    throw new Error(
      `demo: long message body is ${used} bytes, must be under ${DEMO_LONG_MESSAGE_BYTES}`,
    );
  }
  const message = body + '-'.repeat(DEMO_LONG_MESSAGE_BYTES - used);
  if (Buffer.byteLength(message, 'utf8') !== DEMO_LONG_MESSAGE_BYTES) {
    throw new Error('demo: long message padding is wrong');
  }
  return message;
}

/** How long the demo wallet holds the slot before the rival takes it. */
export const RIVAL_HOLD_DELAY_SECONDS = 1800;
/** The rival's bid: above our 0.101 SOL, and low enough that 0.201 is still over the minimum. */
export const RIVAL_BID_SOL = '0.12';
export const RIVAL_MESSAGE = 'new holder. paid 0.12 SOL for this.';

/** `MAX_BID_SOL` plus 0.001 SOL, computed in lamports so the two stay in step. */
export const OVER_LIMIT_BID_SOL = lamportsToSol(
  solToLamports(DEMO_ENV.MAX_BID_SOL) + solToLamports('0.001'),
);

export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const intentPath = options.intentPath ?? resolve(process.cwd(), 'intent.example.md');

  const dir = mkdtempSync(join(tmpdir(), 'agent-billboard-demo-'));
  const steps: DemoStep[] = [];
  let tick = 0;
  const now = () => new Date(DEMO_START.getTime() + 1000 * tick++);

  try {
    // Mainnet-shaped seed: someone already holds the slot at 0.1 SOL. Done
    // through a real mock transaction so get_flip_history has an event to find.
    const creator = Keypair.generate();
    const previousHolder = Keypair.generate();
    const rpc = new MockRpc({
      creator: creator.publicKey,
      now: DEMO_START.getTime() / 1000 - 3600,
    });
    await rpc.acquireAs(previousHolder, solToLamports('0.1'), PREVIOUS_MESSAGE);
    // The seed transaction moved the mock clock 1 s; bring it up to DEMO_START so
    // the previous holder shows a one-hour hold when we take the slot.
    rpc.advanceClock(3600 - 1);

    const wallet = Keypair.generate();
    const config = loadConfig(
      {
        BILLBOARD_KEYPAIR: bs58.encode(wallet.secretKey),
        ...DEMO_ENV,
        INTENT_PATH: intentPath,
        ACTIVITY_LOG_PATH: join(dir, 'billboard-activity.jsonl'),
      },
      { cwd: dir, dotenvPath: null },
    );
    if (!existsSync(intentPath)) {
      warn(`demo: no intent file at ${intentPath}; operator.intent will be null`);
    }

    const context = createContext(config, rpc, { now, warn });
    // The CLI subscribes in write modes; do the same so an outside acquire is
    // noticed (and `outbid_detected` logged) as it happens.
    const subscribed = context.reader.subscribe();
    const server = createServer(context);
    const client = new Client({ name: 'agent-billboard-demo', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    out(
      `agent-billboard-mcp demo on MockRpc (${config.mode} mode, wallet ${wallet.publicKey.toBase58()})`,
    );
    out(`limits: max bid ${DEMO_ENV.MAX_BID_SOL} SOL, daily cap ${DEMO_ENV.DAILY_CAP_SOL} SOL`);
    out(`seed: previous holder at 0.1 SOL, message "${PREVIOUS_MESSAGE}"`);
    out(`subscription: ${subscribed ? 'account changes' : 'none'}`);

    const call = async (tool: string, args: Record<string, unknown>): Promise<DemoStep> => {
      const result = await client.callTool({ name: tool, arguments: args });
      const content = result.content as Array<{ type: string; text?: string }>;
      const step: DemoStep = {
        tool,
        args,
        isError: result.isError === true,
        text: content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n'),
        structured: result.structuredContent,
      };
      steps.push(step);
      out('');
      out(
        `### ${steps.length}. ${tool} ${JSON.stringify(args)}${step.isError ? '  [isError]' : ''}`,
      );
      out(step.text);
      if (step.structured !== undefined) {
        out('structuredContent:');
        out(JSON.stringify(step.structured, null, 2));
      }
      return step;
    };

    await call(READ_BILLBOARD_TOOL, {});
    await call(ACQUIRE_TOOL, {
      dry_run: true,
      reasoning:
        'Checking what the slot costs right now before deciding anything. Dry run only, nothing is signed.',
    });

    // Propose mode: the write tool returns a proposal and signs nothing;
    // approve_proposal re-reads the board, re-checks the limits, then signs.
    const proposed = await call(ACQUIRE_TOOL, {
      message: DEMO_MESSAGE,
      reasoning:
        'Board shows one holder at 0.1 SOL for about an hour with a greeting, nothing that competes with us. Minimum is 0.101 SOL, under the 0.15 SOL ceiling in intent.md, and nothing has been spent today. Bidding the minimum with the one-line bakery message.',
    });
    const proposalId = (proposed.structured as { proposal_id?: unknown } | undefined)?.proposal_id;
    if (typeof proposalId !== 'string') {
      throw new Error('demo: acquire_posting_rights did not return a proposal_id');
    }
    await call(APPROVE_TOOL, { proposal_id: proposalId });
    await call(READ_BILLBOARD_TOOL, {});
    await call(GET_FLIP_HISTORY_TOOL, {});

    // Append 2 000 bytes: three chunks (900 + 900 + 200), so three
    // transactions, each logged as its own `executed` line. Propose mode
    // again, so it is a proposal first and approve_proposal signs it.
    const appendProposed = await call(APPEND_TOOL, {
      message: DEMO_LONG_MESSAGE,
      reasoning:
        'We hold the slot and the one-liner is up. Adding the full menu and ordering details from intent.md: 2000 bytes, well inside the 4096-byte cap with 137 already posted. Append costs transaction fees only, no bid.',
    });
    const appendId = (appendProposed.structured as { proposal_id?: unknown } | undefined)
      ?.proposal_id;
    if (typeof appendId !== 'string') {
      throw new Error('demo: append_message did not return a proposal_id');
    }
    await call(APPROVE_TOOL, { proposal_id: appendId });

    // Someone else takes the slot. This is not a tool call: it is the mock
    // standing in for another wallet on mainnet. The reader is subscribed to
    // account changes (as the CLI is in write modes), so the server notices
    // and logs `outbid_detected` before the agent reads again. Both clocks
    // (the mock's block time and the server's) move forward together.
    rpc.advanceClock(RIVAL_HOLD_DELAY_SECONDS);
    tick += RIVAL_HOLD_DELAY_SECONDS;
    const rival = Keypair.generate();
    await rpc.acquireAs(rival, solToLamports(RIVAL_BID_SOL), RIVAL_MESSAGE);
    out('');
    out(
      `### (not a tool call) outside acquire on the mock: ${rival.publicKey.toBase58()} bids ${RIVAL_BID_SOL} SOL and posts "${RIVAL_MESSAGE}"`,
    );

    await call(READ_BILLBOARD_TOOL, {});

    // A bid over MAX_BID_SOL. The limit check runs before anything is
    // proposed or signed, whatever the agent's reasoning says.
    await call(ACQUIRE_TOOL, {
      bid_sol: OVER_LIMIT_BID_SOL,
      reasoning:
        'Outbid by a rival at 0.12 SOL. Trying to take the slot back with a bid that would keep it, above the 0.2 SOL limit. Expecting the server to refuse this.',
    });

    await call(GET_FLIP_HISTORY_TOOL, {});

    const activity = readActivity(context);
    out('');
    out(`### Activity log (${activity.length} lines, one JSON object per line)`);
    for (const entry of activity) out(JSON.stringify(entry));

    await client.close();
    await server.close();
    return { steps, activity, wallet: wallet.publicKey.toBase58() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readActivity(context: ServerContext): ActivityEntry[] {
  return context.activityLog.entries();
}

function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  runDemo()
    .then((result) => {
      process.stdout.write(
        `\n${result.steps.length} tool calls, ${result.activity.length} activity log lines.\n`,
      );
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`demo failed: ${message}\n`);
      process.exit(1);
    });
}
