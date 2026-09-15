import { Keypair, Transaction, TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  CHUNK_BYTES,
  COMBINED_CHUNK_BYTES,
  ChunkError,
  MAX_TRANSACTION_BYTES,
  chunkForAcquire,
  chunkMessage,
  messageByteLength,
} from '../../src/program/chunk.js';
import { buildAcquireIx, buildAppendIx } from '../../src/program/layout.js';

/** A string that is `n` bytes of ASCII. */
function ascii(n: number): string {
  return 'a'.repeat(n);
}

describe('messageByteLength', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(messageByteLength('')).toBe(0);
    expect(messageByteLength('abc')).toBe(3);
    expect(messageByteLength('é')).toBe(2); // 2-byte
    expect(messageByteLength('€')).toBe(3); // 3-byte
    expect(messageByteLength('😀')).toBe(4); // 4-byte, one code point, two UTF-16 units
    expect('😀'.length).toBe(2);
  });
});

describe('chunkMessage', () => {
  it('returns no chunks for an empty string', () => {
    expect(chunkMessage('')).toEqual([]);
  });

  it('returns one chunk when the message fits', () => {
    expect(chunkMessage('hello')).toEqual(['hello']);
    expect(chunkMessage(ascii(900))).toEqual([ascii(900)]);
  });

  it('splits ASCII at exactly maxBytes', () => {
    const chunks = chunkMessage(ascii(2000));
    expect(chunks.map((c) => c.length)).toEqual([900, 900, 200]);
  });

  it('never splits a code point and no chunk exceeds 900 bytes (emoji-heavy)', () => {
    // Mix of 1-, 2-, 3- and 4-byte code points plus a ZWJ family sequence and
    // a flag, so the 900-byte boundary lands inside multi-byte characters at
    // many different offsets across the chunks.
    const unit = '😀é€a👩‍👩‍👧‍👦🚀b🇦🇺ç';
    const text = unit.repeat(120);
    const chunks = chunkMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(messageByteLength(chunk)).toBeLessThanOrEqual(CHUNK_BYTES);
      // Encoding then decoding must be lossless: a split surrogate would
      // become U+FFFD and change the round-trip.
      expect(Buffer.from(chunk, 'utf8').toString('utf8')).toBe(chunk);
      // No lone surrogate at either edge.
      const first = chunk.charCodeAt(0);
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('fills greedily: a 4-byte emoji that would overflow starts the next chunk', () => {
    // 898 ASCII bytes + a 4-byte emoji = 902 > 900, so the emoji moves.
    const text = ascii(898) + '😀' + 'z';
    expect(chunkMessage(text)).toEqual([ascii(898), '😀z']);
  });

  it('honours a custom maxBytes', () => {
    expect(chunkMessage('abcdefgh', 4)).toEqual(['abcd', 'efgh']);
    expect(chunkMessage('😀😀😀', 4)).toEqual(['😀', '😀', '😀']);
    expect(chunkMessage('😀😀😀', 8)).toEqual(['😀😀', '😀']);
  });

  it('rejects a maxBytes that could not hold one code point', () => {
    expect(() => chunkMessage('x', 3)).toThrow(ChunkError);
    expect(() => chunkMessage('x', 0)).toThrow(ChunkError);
    expect(() => chunkMessage('x', 4.5)).toThrow(ChunkError);
  });
});

describe('chunkForAcquire', () => {
  it('sizes the first chunk for the combined transaction and the rest for their own', () => {
    const { first, rest } = chunkForAcquire(ascii(2000));
    expect(first).toBe(ascii(COMBINED_CHUNK_BYTES));
    expect(rest.map((c) => c.length)).toEqual([900, 2000 - COMBINED_CHUNK_BYTES - 900]);
    expect((first ?? '') + rest.join('')).toBe(ascii(2000));
  });

  it('returns null first for an empty message', () => {
    expect(chunkForAcquire('')).toEqual({ first: null, rest: [] });
  });

  it('returns only first for a short message', () => {
    expect(chunkForAcquire('hi')).toEqual({ first: 'hi', rest: [] });
  });
});

// ---------------------------------------------------------------------------
// Transaction-size proofs. These serialise real legacy transactions with a
// fee payer and blockhash set, signed, exactly as the server will send them.
// ---------------------------------------------------------------------------

const signer = Keypair.generate();
const prevPoster = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;
const recentBlockhash = Keypair.generate().publicKey.toBase58();

function serialisedSize(ixs: TransactionInstruction[]): number {
  const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash });
  tx.add(...ixs);
  tx.sign(signer);
  return tx.serialize().length;
}

function tooLarge(ixs: TransactionInstruction[]): boolean {
  try {
    serialisedSize(ixs);
    return false;
  } catch (err) {
    return err instanceof Error && /too large/i.test(err.message);
  }
}

describe('transaction size proofs', () => {
  it('one append of a 900-byte chunk fits a legacy transaction with margin', () => {
    const size = serialisedSize([buildAppendIx(signer.publicKey, ascii(CHUNK_BYTES))]);
    expect(size).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    // Prove the margin: measured 1149 bytes, 83 spare.
    expect(size).toBe(1149);
    expect(MAX_TRANSACTION_BYTES - size).toBe(83);
  });

  it('a 900-byte chunk of 4-byte code points is the same size as ASCII', () => {
    const emoji = '😀'.repeat(CHUNK_BYTES / 4);
    expect(messageByteLength(emoji)).toBe(CHUNK_BYTES);
    expect(serialisedSize([buildAppendIx(signer.publicKey, emoji)])).toBe(1149);
  });

  it('acquire + 900-byte append does NOT fit (why COMBINED_CHUNK_BYTES exists)', () => {
    const accounts = { signer: signer.publicKey, prevPoster, creator };
    expect(
      tooLarge([
        buildAcquireIx(accounts, 101_000_000n),
        buildAppendIx(signer.publicKey, ascii(CHUNK_BYTES)),
      ]),
    ).toBe(true);
  });

  it('acquire + COMBINED_CHUNK_BYTES append fits, and one more byte does not', () => {
    const accounts = { signer: signer.publicKey, prevPoster, creator };
    const fits = serialisedSize([
      buildAcquireIx(accounts, 101_000_000n),
      buildAppendIx(signer.publicKey, ascii(COMBINED_CHUNK_BYTES)),
    ]);
    expect(fits).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    expect(fits).toBe(MAX_TRANSACTION_BYTES); // zero spare, see chunk.ts header
    expect(
      tooLarge([
        buildAcquireIx(accounts, 101_000_000n),
        buildAppendIx(signer.publicKey, ascii(COMBINED_CHUNK_BYTES + 1)),
      ]),
    ).toBe(true);
  });

  it('acquire + COMBINED_CHUNK_BYTES has spare bytes when prev poster and creator coincide', () => {
    // Fewer distinct accounts only makes the transaction smaller, so the
    // six-account case above is the binding one.
    const accounts = { signer: signer.publicKey, prevPoster: creator, creator };
    const size = serialisedSize([
      buildAcquireIx(accounts, 101_000_000n),
      buildAppendIx(signer.publicKey, ascii(COMBINED_CHUNK_BYTES)),
    ]);
    expect(size).toBeLessThan(MAX_TRANSACTION_BYTES);
  });
});
