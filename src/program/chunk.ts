/**
 * Message chunking for The Agent Billboard.
 *
 * The program measures messages in UTF-8 bytes, not characters, and one
 * legacy Solana transaction can only carry so many bytes of instruction data.
 * This module splits a message into chunks that each fit in one `append`
 * transaction, never splitting a multi-byte character (a chunk boundary is
 * always a Unicode code point boundary, so surrogate pairs stay together).
 *
 * Sizes were measured by serialising real transactions with `@solana/web3.js`
 * (see `test/program/chunk.test.ts`, which re-proves them on every run):
 *
 *   append of 900 bytes alone            -> 1149 bytes  (limit 1232, 83 spare)
 *   acquire + append of 900 bytes        -> 1237 bytes  (too large)
 *   acquire + append of 895 bytes        -> 1232 bytes  (largest that fits)
 *
 * The combined figure assumes the worst case of six distinct accounts
 * (billboard, previous poster, creator, signer, system program, program).
 * It has zero spare bytes: adding any further instruction to that transaction
 * (for example a compute-budget / priority-fee instruction) would require
 * lowering COMBINED_CHUNK_BYTES.
 */

/** Bytes per `append` chunk when the chunk is sent in its own transaction. */
export const CHUNK_BYTES = 900;

/**
 * Bytes of message that fit alongside an `acquire` in the same transaction.
 * Measured as the largest value that serialises within 1232 bytes.
 */
export const COMBINED_CHUNK_BYTES = 895;

/** Solana's maximum serialised transaction size (PACKET_DATA_SIZE). */
export const MAX_TRANSACTION_BYTES = 1232;

/** Any single UTF-8 code point is at most four bytes. */
const MAX_CODE_POINT_BYTES = 4;

export class ChunkError extends Error {
  override readonly name = 'ChunkError';
  constructor(message: string) {
    super(message);
  }
}

/** Byte length of a string when encoded as UTF-8 (what the program counts). */
export function messageByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Splits `text` into chunks of at most `maxBytes` UTF-8 bytes each, cutting
 * only on code point boundaries. Chunks are filled greedily in order, so
 * concatenating them reproduces `text` exactly. An empty string yields no
 * chunks.
 *
 * Splits happen at the byte budget, not at whitespace: the program appends
 * bytes contiguously, so the boundary is invisible once every chunk lands.
 */
export function chunkMessage(text: string, maxBytes: number = CHUNK_BYTES): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < MAX_CODE_POINT_BYTES) {
    throw new ChunkError(
      `maxBytes must be an integer of at least ${MAX_CODE_POINT_BYTES}, got ${maxBytes}`,
    );
  }
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  // `for..of` iterates by code point, so a surrogate pair arrives as one unit.
  for (const codePoint of text) {
    const bytes = messageByteLength(codePoint);
    if (currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Splits a message for an acquire-and-post: the first chunk is sized to
 * share the acquire transaction, the rest are sized for their own
 * transactions. `first` is `null` for an empty message.
 */
export function chunkForAcquire(text: string): { first: string | null; rest: string[] } {
  const [first, ...remainder] = chunkMessage(text, COMBINED_CHUNK_BYTES);
  if (first === undefined) {
    return { first: null, rest: [] };
  }
  return { first, rest: chunkMessage(remainder.join(''), CHUNK_BYTES) };
}
