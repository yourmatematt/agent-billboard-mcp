/**
 * Captures everything a piece of code writes to stdout and stderr, through
 * either the streams or `console`, so a test can assert a secret never
 * appears in any of it. Nothing captured reaches the terminal.
 */
import { format } from 'node:util';
import { vi } from 'vitest';

export interface Captured {
  /** Everything written, in order, both channels together. */
  readonly text: () => string;
  readonly restore: () => void;
}

export function captureOutput(): Captured {
  const chunks: string[] = [];
  const record = (...parts: unknown[]): void => {
    const [first] = parts;
    chunks.push(
      parts.length === 1 && first instanceof Uint8Array
        ? Buffer.from(first).toString('utf8')
        : format(...parts),
    );
  };
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      record(chunk);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      record(chunk);
      return true;
    }),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(record),
    ),
  ];
  return {
    text: () => chunks.join('\n'),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/** Runs `fn`, capturing its output; errors are recorded as text too, then the output returned. */
export async function captureAll(fn: () => unknown): Promise<string> {
  const cap = captureOutput();
  try {
    await fn();
  } catch (err) {
    cap.restore();
    return `${cap.text()}\n${err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err)}`;
  }
  cap.restore();
  return cap.text();
}
