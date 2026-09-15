/**
 * Append-only JSONL activity log.
 *
 * Every write the server considers, proposes, refuses or performs lands
 * here as one JSON object per line, with the model's `reasoning` and the
 * transaction signature when there is one. This file is the audit trail a
 * reviewer reads; the spend limiter also reads it to compute the rolling
 * 24-hour total. It is therefore treated as a ledger:
 *
 *   - append only: the file is opened in append mode, one line per entry,
 *     and fsync'd before `append` returns, so a crash after `append` cannot
 *     lose an entry the server has already acted on;
 *   - schema-checked on the way in: an entry is validated against a strict
 *     zod object before it is serialised, so unknown fields (and therefore
 *     anything resembling a secret key) cannot be written by accident;
 *   - tolerant on the way out: a missing file is an empty log, and a line
 *     that fails to parse is skipped with a warning to stderr rather than
 *     taking the server down;
 *   - money as decimal SOL strings (`bid_sol: "0.101"`), never floats.
 *
 * Nothing here writes to stdout.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { z } from 'zod';

export const ACTIVITY_EVENTS = [
  'proposed',
  'approved',
  'executed',
  'refused_limit',
  'refused_not_poster',
  'failed',
  'outbid_detected',
  'expired',
] as const;

export type ActivityEvent = (typeof ACTIVITY_EVENTS)[number];

export const MAX_REASONING_CHARS = 2000;

const solString = z
  .string()
  .regex(/^\d+(\.\d{1,9})?$/, 'must be a plain decimal SOL string with at most 9 decimals');

const billboardSnapshot = z
  .object({
    poster: z.string().min(1),
    amount_sol: solString,
  })
  .strict();

export type BillboardSnapshot = z.infer<typeof billboardSnapshot>;

/**
 * The strict schema for one log line. `.strict()` is the guard that keeps
 * secrets out: a caller cannot smuggle an extra field through `append`.
 */
export const activityEntrySchema = z
  .object({
    ts: z.iso.datetime(),
    event: z.enum(ACTIVITY_EVENTS),
    tool: z.string().min(1),
    reasoning: z.string().max(MAX_REASONING_CHARS).optional(),
    proposal_id: z.string().min(1).optional(),
    bid_sol: solString.optional(),
    tx: z.string().min(1).optional(),
    error: z.string().optional(),
    billboard_before: billboardSnapshot.optional(),
    billboard_after: billboardSnapshot.optional(),
  })
  .strict();

export type ActivityEntry = z.infer<typeof activityEntrySchema>;

/** What callers pass to `append`: everything but the timestamp, which the log stamps. */
export type ActivityEntryInput = Omit<ActivityEntry, 'ts'> & { ts?: string };

export class ActivityLogError extends Error {
  override readonly name = 'ActivityLogError';
  constructor(message: string) {
    super(message);
  }
}

export interface ActivityLogOptions {
  /** Clock used to stamp entries. Injectable for tests. Default `() => new Date()`. */
  now?: () => Date;
  /** Where warnings about unreadable lines go. Default: stderr. */
  warn?: (message: string) => void;
}

export interface ReadResult {
  entries: ActivityEntry[];
  /** Lines that were not blank but did not parse or validate. */
  skipped: number;
}

export class ActivityLog {
  readonly path: string;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;

  constructor(path: string, options: ActivityLogOptions = {}) {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new ActivityLogError('activity log path must be a non-empty string');
    }
    this.path = path;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /**
   * Validates, serialises, appends and fsyncs one entry. Returns the entry
   * as written (with its timestamp). Throws `ActivityLogError` if the entry
   * does not match the schema; nothing is written in that case.
   */
  append(input: ActivityEntryInput): ActivityEntry {
    const candidate = { ...input, ts: input.ts ?? this.now().toISOString() };
    const parsed = activityEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`)
        .join('; ');
      throw new ActivityLogError(`refusing to log an invalid activity entry (${issues})`);
    }
    const entry = parsed.data;
    const line = `${JSON.stringify(entry)}\n`;

    let fd: number | null = null;
    try {
      fd = openSync(this.path, 'a');
      writeSync(fd, line, null, 'utf8');
      fsyncSync(fd);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      throw new ActivityLogError(`could not append to activity log ${this.path} (${code})`);
    } finally {
      if (fd !== null) closeSync(fd);
    }
    return entry;
  }

  /**
   * Reads every entry in file order. A missing file is an empty log. Lines
   * that are blank are ignored; lines that fail to parse or validate are
   * counted in `skipped` and reported through `warn`.
   */
  read(): ReadResult {
    if (!existsSync(this.path)) return { entries: [], skipped: 0 };
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      throw new ActivityLogError(`could not read activity log ${this.path} (${code})`);
    }
    const entries: ActivityEntry[] = [];
    let skipped = 0;
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim() ?? '';
      if (line === '') continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        skipped++;
        this.warn(`activity log ${this.path}: line ${i + 1} is not valid JSON, skipped`);
        continue;
      }
      const parsed = activityEntrySchema.safeParse(json);
      if (!parsed.success) {
        skipped++;
        this.warn(`activity log ${this.path}: line ${i + 1} is not a valid entry, skipped`);
        continue;
      }
      entries.push(parsed.data);
    }
    return { entries, skipped };
  }

  /** All valid entries, oldest first. */
  entries(): ActivityEntry[] {
    return this.read().entries;
  }

  /**
   * Entries whose timestamp is at or after `since` (inclusive), oldest first.
   * Accepts a `Date`, epoch milliseconds, or an ISO string.
   */
  entriesSince(since: Date | number | string): ActivityEntry[] {
    const cutoff = toEpochMs(since);
    return this.entries().filter((entry) => Date.parse(entry.ts) >= cutoff);
  }
}

function toEpochMs(value: Date | number | string): number {
  const ms =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ActivityLogError(`invalid timestamp: ${String(value)}`);
  }
  return ms;
}
