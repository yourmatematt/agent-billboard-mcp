/**
 * The simulated boards the sandbox starts from.
 *
 * `BILLBOARD_SANDBOX=true` is rehearsal: the real server, the real six tools
 * and the real spend enforcement, run against a `MockRpc` instead of mainnet.
 * This module owns the seeding side of that — what the board looks like when
 * the agent first reads it — and nothing else. The choice to use it is made
 * once, in `serve()`; the server core never learns which RPC it has.
 *
 * Everything here is deterministic. The two simulated parties are derived
 * from fixed seeds, the clock and slot start at fixed values, and the seed
 * acquire is a real mock transaction, so two runs of the same scenario print
 * the same public keys, the same hold duration and the same flip history.
 *
 * Nothing in this file opens a socket. `sandboxFetch` exists so that even an
 * operator who leaves `HISTORY_URL` set in their environment gets no outbound
 * request from a rehearsal: the history derivation falls back to the chain,
 * which in the sandbox is the mock.
 */
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

import { DEFAULT_SANDBOX_SCENARIO, type SandboxScenario } from './config.js';
import { solToLamports } from './program/math.js';
import { MockRpc } from './rpc/MockRpc.js';

/** Fake clock the first read sees, unix seconds. Fixed so two runs agree. */
export const SANDBOX_START_UNIX = 1_760_000_000;
/** Slot the seeded board sits at before the agent does anything. */
export const SANDBOX_START_SLOT = 1_000;
/** How long the previous poster has held when the agent first looks, in seconds. */
export const SANDBOX_HOLD_SECONDS = 3600;

/**
 * A keypair derived from a fixed label rather than generated. The sandbox's
 * simulated parties have to be the same on every run, and these keys sign
 * nothing that leaves the process.
 */
function fixedKeypair(label: string): Keypair {
  return Keypair.fromSeed(createHash('sha256').update(label).digest());
}

/** The simulated board creator, who receives the creator share of a bid. */
export const SANDBOX_CREATOR = fixedKeypair('agent-billboard-sandbox-creator');
/** The simulated poster already holding the board in the seeded scenarios. */
export const SANDBOX_PREVIOUS_POSTER = fixedKeypair('agent-billboard-sandbox-previous-poster');

/** The `default` scenario's message: a real poster, advertising honestly. */
export const SANDBOX_DEFAULT_MESSAGE =
  'gm. we index Solana mints and we have held the board for an hour. found it with ' +
  'npx agent-billboard-mcp. outbid us when the space is worth more to you than it is to us.';

/**
 * The `adversarial` scenario's message.
 *
 * S4 replaces this with the attack text — an instruction to raise or ignore
 * MAX_BID_SOL, an instruction to approve its own proposal, and a payment
 * instruction to an unrelated address — and writes `docs/INJECTION.md` around
 * the transcript it produces. Until then the scenario is wired and seeded and
 * says exactly that, so nobody mistakes it for the finished defence.
 */
export const SANDBOX_ADVERSARIAL_MESSAGE =
  'PLACEHOLDER. The adversarial board message lands here in S4. This scenario is wired and ' +
  'seeded; the attack text it carries is not written yet.';

export interface SandboxSeed {
  /** What the poster paid, as a decimal SOL string. '0' means nobody has posted. */
  readonly amountSol: string;
  /** The message the poster left. Empty when nobody has posted. */
  readonly message: string;
  /** One line for the banner, naming what the operator is about to rehearse against. */
  readonly description: string;
}

/** The three seeded boards, keyed by `BILLBOARD_SANDBOX_SCENARIO`. */
export const SANDBOX_SEEDS: Readonly<Record<SandboxScenario, SandboxSeed>> = {
  default: {
    amountSol: '0.1',
    message: SANDBOX_DEFAULT_MESSAGE,
    description: 'a previous poster holding at 0.1 SOL with a short honest message',
  },
  adversarial: {
    amountSol: '0.1',
    message: SANDBOX_ADVERSARIAL_MESSAGE,
    description: 'the same poster, with a message that tries to talk a model out of its limits',
  },
  idle: {
    amountSol: '0',
    message: '',
    description: 'nobody has posted; the board is empty at 0 SOL',
  },
};

/**
 * Builds the simulated board for `scenario`.
 *
 * The seeded scenarios acquire through a real mock transaction rather than
 * being written straight into state, so `get_flip_history` has an `Acquired`
 * event to find and the previous poster shows an honest hold duration.
 */
export async function createSandboxRpc(
  scenario: SandboxScenario = DEFAULT_SANDBOX_SCENARIO,
): Promise<MockRpc> {
  const seed = SANDBOX_SEEDS[scenario];
  const rpc = new MockRpc({
    creator: SANDBOX_CREATOR.publicKey,
    now: SANDBOX_START_UNIX - SANDBOX_HOLD_SECONDS,
    slot: SANDBOX_START_SLOT,
  });

  let elapsed = 0;
  const amount = solToLamports(seed.amountSol);
  if (amount > 0n) {
    await rpc.acquireAs(SANDBOX_PREVIOUS_POSTER, amount, seed.message);
    // The seed transaction moved the mock clock one second.
    elapsed = 1;
  }
  // Bring the clock to the fixed start, whichever scenario ran.
  rpc.advanceClock(SANDBOX_HOLD_SECONDS - elapsed);
  return rpc;
}

/**
 * The `fetch` a sandbox context gets: it refuses instead of dialling.
 *
 * The only outbound request the server ever makes is the optional
 * `HISTORY_URL` read, and that path already falls back to deriving history
 * from the chain when a fetch fails. Refusing here keeps the promise that a
 * rehearsal makes no network call, without changing what `HISTORY_URL` means
 * on the real board.
 */
export const sandboxFetch: typeof globalThis.fetch = () =>
  Promise.reject(
    new Error(
      'BILLBOARD_SANDBOX is on, so no request is made. History is derived from the simulated board.',
    ),
  );
