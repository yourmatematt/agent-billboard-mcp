/**
 * Reader state on disk: what the agent last looked at, and the newest state
 * this wallet has seen, kept in one small JSON file per working directory.
 *
 * A heartbeat host starts a fresh server on every wake. Without this file
 * every wake would be a first read, so `changed_since_last_read` could never
 * report a move that happened between wakes, and an outbid between wakes
 * would never be logged. With it, the reader picks up where the previous
 * process left off.
 *
 * Rules:
 *   - The file is only used when its program, billboard and wallet all match
 *     the running server. Anything else is ignored and replaced on the next
 *     write, so a folder that changes wallet starts from a first read.
 *   - Writes are atomic: a temp file beside the target, then a rename.
 *   - A corrupt, unreadable or unwritable file is a warning, never a crash.
 *     Nothing here writes to stdout.
 *   - States are stored losslessly: lamports as a decimal string, the message
 *     as base64 of its UTF-8 bytes, beside the on-chain byte length.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

import type { BillboardState } from '../program/layout.js';

export const READER_STATE_VERSION = 1;

/** Who the state belongs to. A file for anyone else is ignored. */
export interface ReaderStateIdentity {
  programId: string;
  billboard: string;
  /** Base58 wallet, or null in read-only mode. */
  wallet: string | null;
}

export interface ReaderStateSnapshot {
  lastSeen: BillboardState | null;
  lastObserved: BillboardState | null;
}

const base58Key = z.string().refine(
  (value) => {
    try {
      new PublicKey(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'not a base58 public key' },
);

const storedStateSchema = z.object({
  creator: base58Key,
  poster: base58Key,
  amount_lamports: z.string().regex(/^\d+$/),
  message_base64: z.string(),
  message_bytes: z.number().int().min(0),
});

const fileSchema = z.object({
  version: z.literal(READER_STATE_VERSION),
  program_id: z.string(),
  billboard: z.string(),
  wallet: z.string().nullable(),
  last_seen: storedStateSchema.nullable(),
  last_observed: storedStateSchema.nullable(),
  updated_at: z.string(),
});

type StoredState = z.infer<typeof storedStateSchema>;
type StateFile = z.infer<typeof fileSchema>;

function toStored(state: BillboardState): StoredState {
  return {
    creator: state.creator.toBase58(),
    poster: state.poster.toBase58(),
    amount_lamports: state.amount.toString(),
    message_base64: Buffer.from(state.message, 'utf8').toString('base64'),
    message_bytes: state.messageBytes,
  };
}

function fromStored(stored: StoredState): BillboardState {
  return {
    creator: new PublicKey(stored.creator),
    poster: new PublicKey(stored.poster),
    amount: BigInt(stored.amount_lamports),
    message: Buffer.from(stored.message_base64, 'base64').toString('utf8'),
    messageBytes: stored.message_bytes,
  };
}

export interface ReaderStateStoreOptions {
  /** Clock for `updated_at`. Injectable for tests. */
  now?: () => Date;
  /** Where warnings go. Default: stderr. */
  warn?: (message: string) => void;
}

export class ReaderStateStore {
  readonly path: string;
  private readonly identity: ReaderStateIdentity;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private writeWarned = false;

  constructor(path: string, identity: ReaderStateIdentity, options: ReaderStateStoreOptions = {}) {
    this.path = path;
    this.identity = identity;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /**
   * Returns the saved states when the file exists, parses and belongs to
   * this program, billboard and wallet. Returns null otherwise, with a
   * warning when a file was there but could not be used.
   */
  load(): ReaderStateSnapshot | null {
    if (!existsSync(this.path)) return null;
    let file: StateFile;
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (!parsed.success) {
        this.warn(
          `reader state file ${this.path} is not in the expected format; treating this as a first read`,
        );
        return null;
      }
      file = parsed.data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(
        `reader state file ${this.path} could not be read (${message}); treating this as a first read`,
      );
      return null;
    }
    if (
      file.program_id !== this.identity.programId ||
      file.billboard !== this.identity.billboard ||
      file.wallet !== this.identity.wallet
    ) {
      this.warn(
        `reader state file ${this.path} belongs to a different program, billboard or wallet; ` +
          'treating this as a first read (the next read replaces it)',
      );
      return null;
    }
    return {
      lastSeen: file.last_seen === null ? null : fromStored(file.last_seen),
      lastObserved: file.last_observed === null ? null : fromStored(file.last_observed),
    };
  }

  /** Writes both states atomically. A failure is warned about once and otherwise ignored. */
  save(snapshot: ReaderStateSnapshot): void {
    const file: StateFile = {
      version: READER_STATE_VERSION,
      program_id: this.identity.programId,
      billboard: this.identity.billboard,
      wallet: this.identity.wallet,
      last_seen: snapshot.lastSeen === null ? null : toStored(snapshot.lastSeen),
      last_observed: snapshot.lastObserved === null ? null : toStored(snapshot.lastObserved),
      updated_at: this.now().toISOString(),
    };
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.path);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Nothing more to do: the warning below is the report.
      }
      if (!this.writeWarned) {
        this.writeWarned = true;
        const message = err instanceof Error ? err.message : String(err);
        this.warn(
          `could not write reader state file ${this.path} (${message}); ` +
            'the next process will treat its first read as a first read',
        );
      }
    }
  }
}
