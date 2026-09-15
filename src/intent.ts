/**
 * Operator intent file (`intent.md`).
 *
 * The operator writes their goals for the billboard in plain prose: what
 * they want to post, what the slot is worth to them, when to walk away. The
 * text is returned verbatim under `operator.intent` in every `read_billboard`
 * response so the agent reasons with the operator's goals in front of it.
 *
 * Two properties matter:
 *
 *   - It is re-read from disk on every call. There is no cache, so the
 *     operator can edit the file and the next read picks it up without a
 *     server restart.
 *   - It is advisory. Nothing in this file changes what the server will
 *     sign. `MAX_BID_SOL` and `DAILY_CAP_SOL` are enforced in code
 *     regardless of what the intent says.
 *
 * A missing file is not an error: the intent is simply `null`.
 */
import { readFileSync } from 'node:fs';

/** Largest intent the server will pass to the model, in bytes. */
export const INTENT_MAX_BYTES = 8 * 1024;

export class IntentError extends Error {
  override readonly name = 'IntentError';
  constructor(message: string) {
    super(message);
  }
}

export interface IntentFile {
  /** Absolute or relative path as configured. */
  path: string;
  /** File contents (UTF-8, BOM stripped), cut at `INTENT_MAX_BYTES` if larger. */
  text: string;
  /** Size of the file on disk in bytes, before any truncation. */
  bytes: number;
  /** True when the file was larger than `INTENT_MAX_BYTES` and was cut. */
  truncated: boolean;
}

const UTF8_BOM = 0xfeff;

/**
 * Reads the intent file at `path`. Returns `null` when there is no such file
 * (or the path points at a directory). Any other read failure — for example
 * a permissions problem — throws `IntentError`, because a file the operator
 * wrote and expects to be used must not be silently ignored.
 *
 * Files larger than `INTENT_MAX_BYTES` are cut at that byte budget on a UTF-8
 * character boundary and flagged `truncated`.
 */
export function readIntent(path: string): IntentFile | null {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new IntentError('intent path must be a non-empty string');
  }
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw new IntentError(`could not read intent file ${path} (${code ?? 'unknown error'})`);
  }
  const bytes = raw.length;
  const truncated = bytes > INTENT_MAX_BYTES;
  const slice = truncated ? cutAtUtf8Boundary(raw, INTENT_MAX_BYTES) : raw;
  let text = slice.toString('utf8');
  if (text.charCodeAt(0) === UTF8_BOM) text = text.slice(1);
  return { path, text, bytes, truncated };
}

/**
 * Convenience for the tools: the intent text, or `null` when there is no
 * file. Re-reads on every call. Truncation is reported through `warn` so it
 * shows up on stderr without failing the read.
 */
export function loadIntent(
  path: string,
  warn: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
): string | null {
  const file = readIntent(path);
  if (file === null) return null;
  if (file.truncated) {
    warn(
      `intent file ${path} is ${file.bytes} bytes; only the first ${INTENT_MAX_BYTES} bytes are used`,
    );
  }
  return file.text;
}

/**
 * Cuts `buf` to at most `maxBytes` without ending inside a multi-byte UTF-8
 * sequence. Walks back over continuation bytes (10xxxxxx) to the start of
 * the character that would have been split, and drops it.
 */
export function cutAtUtf8Boundary(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  let end = maxBytes;
  // If the byte at `end` is a continuation byte, the character starting
  // before it straddles the cut; back up to that character's lead byte.
  while (end > 0 && isContinuationByte(buf[end] as number)) end--;
  return buf.subarray(0, end);
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}
