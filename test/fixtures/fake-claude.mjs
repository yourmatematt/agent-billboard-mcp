/**
 * A fake `claude` for tests. It never calls a model and never touches the
 * network. Every wake in every test runs this, never the real CLI.
 *
 * It reads the prompt from stdin, then appends one JSON line describing the
 * call to `fake-claude.calls.jsonl` next to this file:
 *   { argv, cwd, stdin, pid, envKeys, switches }
 * (`envKeys` are names only, never values, so no login secret is copied.)
 *
 * FAKE_CLAUDE_MODE steers it:
 *   succeed           (default) a stream-json transcript ending in a `result`
 *                     event whose text closes with DECISION and NEXT_LOOK
 *                     lines (FAKE_CLAUDE_RESULT replaces that text); exit 0
 *   malformed         a `result` event whose closing lines cannot be read; exit 0
 *   fail              an init event, a line on stderr, exit 3
 *   hang              an init event, then never exits
 *   reject-max-turns  given --max-turns: refuses it like a CLI without the
 *                     flag (stderr, exit 1, no stdout); otherwise succeed
 */
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || 'succeed';

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

const SEEN =
  /^(BILLBOARD_|CLAUDE|MAX_BID_SOL$|DAILY_CAP_SOL$|AUTO_BID$|INTENT_PATH$|RPC_URL$|STATE_PATH$|ACTIVITY_LOG_PATH$|HISTORY_URL$|FAKE_)/i;
const switches = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^CLAUDE_CODE_DISABLE_/i.test(key)) switches[key] = value;
}
appendFileSync(
  join(here, 'fake-claude.calls.jsonl'),
  `${JSON.stringify({
    argv,
    cwd: process.cwd(),
    stdin,
    pid: process.pid,
    envKeys: Object.keys(process.env)
      .filter((k) => SEEN.test(k))
      .sort(),
    switches,
  })}\n`,
);

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const init = () =>
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [], mcp_servers: [] });
const assistant = (text) =>
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const result = (text) =>
  emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: text });

const SUCCESS_TEXT = [
  'I read the board and the last twenty flips.',
  'DECISION: passed - The minimum bid is more than this belief is worth today.',
  'NEXT_LOOK: 6 - Nothing has moved for a day.',
].join('\n');

if (mode === 'reject-max-turns' && argv.includes('--max-turns')) {
  process.stderr.write("error: unknown option '--max-turns'\n");
  process.exitCode = 1;
} else if (mode === 'succeed' || mode === 'reject-max-turns') {
  init();
  // Different closing lines from the result's: the result event must win.
  assistant('Thinking.\nDECISION: error - this is not the final reply\nNEXT_LOOK: 2 - no');
  result(process.env.FAKE_CLAUDE_RESULT || SUCCESS_TEXT);
} else if (mode === 'malformed') {
  init();
  result('I could not make up my mind.\nDECISION maybe later\nNEXT_LOOK: soon - who knows');
} else if (mode === 'fail') {
  init();
  process.stderr.write('fake claude: failed on purpose\n');
  process.exitCode = 3;
} else if (mode === 'hang') {
  init();
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(`fake claude: unknown FAKE_CLAUDE_MODE ${mode}\n`);
  process.exitCode = 64;
}
