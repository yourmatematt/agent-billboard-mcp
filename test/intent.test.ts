import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  INTENT_MAX_BYTES,
  IntentError,
  cutAtUtf8Boundary,
  loadIntent,
  readIntent,
} from '../src/intent.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abm-intent-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readIntent', () => {
  it('returns null when the file is missing', () => {
    expect(readIntent(join(dir, 'intent.md'))).toBeNull();
    expect(loadIntent(join(dir, 'intent.md'))).toBeNull();
  });

  it('returns null when the path is a directory', () => {
    expect(readIntent(dir)).toBeNull();
  });

  it('returns null when a path component is a file, not a directory', () => {
    writeFileSync(join(dir, 'file'), 'x');
    expect(readIntent(join(dir, 'file', 'intent.md'))).toBeNull();
  });

  it('reads the file verbatim, including multi-byte characters', () => {
    const path = join(dir, 'intent.md');
    const text = '# Intent\n\nPost the café menu. Walk away above 0.2 SOL. \u{1F600}\n';
    writeFileSync(path, text, 'utf8');
    const file = readIntent(path);
    expect(file).not.toBeNull();
    expect(file?.text).toBe(text);
    expect(file?.bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(file?.truncated).toBe(false);
    expect(loadIntent(path)).toBe(text);
  });

  it('strips a UTF-8 byte order mark', () => {
    const path = join(dir, 'intent.md');
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]));
    expect(readIntent(path)?.text).toBe('hello');
  });

  it('re-reads on every call so edits apply without a restart', () => {
    const path = join(dir, 'intent.md');
    writeFileSync(path, 'first');
    expect(loadIntent(path)).toBe('first');
    writeFileSync(path, 'second');
    expect(loadIntent(path)).toBe('second');
    rmSync(path);
    expect(loadIntent(path)).toBeNull();
  });

  it('truncates files over 8 KB on a UTF-8 boundary and reports it', () => {
    const path = join(dir, 'intent.md');
    // 'é' is two bytes; an odd byte budget guarantees the cut lands mid-character.
    const text = 'é'.repeat(INTENT_MAX_BYTES); // 16 KB on disk
    writeFileSync(path, text, 'utf8');
    const file = readIntent(path);
    expect(file?.truncated).toBe(true);
    expect(file?.bytes).toBe(INTENT_MAX_BYTES * 2);
    const outBytes = Buffer.byteLength(file?.text ?? '', 'utf8');
    expect(outBytes).toBeLessThanOrEqual(INTENT_MAX_BYTES);
    expect(file?.text).toBe('é'.repeat(outBytes / 2)); // no replacement characters
    expect(file?.text).not.toContain('�');

    const warnings: string[] = [];
    const text2 = loadIntent(path, (m) => warnings.push(m));
    expect(text2).toBe(file?.text);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(String(INTENT_MAX_BYTES));
  });

  it('rejects an empty path', () => {
    expect(() => readIntent('')).toThrow(IntentError);
  });
});

describe('cutAtUtf8Boundary', () => {
  it('never ends inside a multi-byte sequence', () => {
    const buf = Buffer.from('a\u{1F600}b', 'utf8'); // 1 + 4 + 1 bytes
    for (let max = 0; max <= buf.length; max++) {
      const cut = cutAtUtf8Boundary(buf, max);
      expect(cut.length).toBeLessThanOrEqual(max);
      expect(cut.toString('utf8')).not.toContain('�');
    }
    expect(cutAtUtf8Boundary(buf, 2).toString('utf8')).toBe('a');
    expect(cutAtUtf8Boundary(buf, 5).toString('utf8')).toBe('a\u{1F600}');
    expect(cutAtUtf8Boundary(buf, 6)).toBe(buf);
  });

  it('treats an empty directory at the intent path as no intent', () => {
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    expect(readIntent(nested)).toBeNull();
  });
});
