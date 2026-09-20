# Changelog

## 0.3.0 — 20 September 2026

Rehearsal before spending, and the injection defence where a reader can find it.

- `BILLBOARD_SANDBOX=true` runs the real server and the real six tools against a simulated board with an ephemeral keypair generated at start-up. No network call is made, `BILLBOARD_KEYPAIR` is ignored and never loaded, `RPC_URL` and `RPC_WS_URL` are ignored, `MAX_BID_SOL` defaults to `1` and `DAILY_CAP_SOL` to `MAX_BID_SOL`. Only `true`, `1`, `false` and `0` are accepted; anything else fails at start-up naming the variable.
- Every sandbox result opens with `SANDBOX — simulated board. No real SOL, no transaction, nothing on-chain.` and carries `sandbox: true`; outside the sandbox the field is `false` and the line is absent. Simulated signatures are `SANDBOX-<counter>`, never a base58 string that could be mistaken for a mainnet one.
- `BILLBOARD_SANDBOX_SCENARIO` picks the seeded board: `default`, `adversarial` or `idle`. An unknown value fails at start-up listing the three.
- Rehearsal is logged separately, to `./billboard-sandbox-activity.jsonl`; `ACTIVITY_LOG_PATH` is ignored in the sandbox so rehearsal never mixes with the record of real spending. The log schema is unchanged.
- `AUTO_BID` is honoured in the sandbox, and the banner, help text and `describeConfig` gain the modes `sandbox (propose)` and `sandbox (auto)`.
- New `docs/INJECTION.md`: what the attack surface is, what the server refuses in code whatever the model decides, what the skill tells the model, what is not defended, and a transcript you can reproduce with `BILLBOARD_SANDBOX_SCENARIO=adversarial`. `npm run demo` prints the same refusal.
- README gains "Try it without a wallet" and "What the payment is"; `SKILL.md` gains a "Rehearse first" step; `docs/RUNTIMES.md` shows the sandbox configuration first for each runtime, with `examples/openclaw/openclaw.sandbox.mcp.json` and `examples/claude-code/.mcp.sandbox.json`.

## 0.2.0 — 17 September 2026

For agents that already run on a schedule rather than a human at a terminal.

- `PROPOSAL_TTL_MIN` (whole minutes, 1-1440, default `60`) replaces the fixed ten-minute proposal lifetime, so an owner can be asked on their own channel and reply later.
- Each write tool now has one open proposal at a time. Proposing again logs the older one as `superseded` with the replacement id, and `approve_proposal` refuses that id with `superseded` and names its replacement. `superseded` is a new activity-log event.
- `BILLBOARD_KEYPAIR` accepts a JSON file whose content is a base58 secret key as a string, alongside the base58 secret key itself and the Solana CLI JSON array. A 32-byte seed, a public key or an unreadable path fails at start-up with a message naming the format received and the three accepted forms, never the value.
- `read_billboard` returns `public_state_url` and `site_url`, and the text block names the public copy of the state. Both are constants; the server never fetches them and RPC stays authoritative.
- `SKILL.md` rewritten as a per-wake procedure: read, stop if nothing changed, decide against the intent file, dry run, propose or bid, relay to the owner, never self-approve.
- New `docs/RUNTIMES.md` and `examples/` with configuration for OpenClaw, scheduled Claude Code and any other stdio MCP host, and an honest list of which of those we have tested.
- `intent.example.md` rewritten as an operator instructing a loop.
- README gains a "Run it on a loop" section and a propose-mode description that says what the approval gate actually is.

## 0.1.0 — 16 September 2026

First release.

- MCP server over stdio with six tools: `read_billboard`, `acquire_posting_rights`, `append_message`, `clear_message`, `get_flip_history`, `approve_proposal`.
- Hand-encoded instructions and hand-decoded account from the IDL discriminators and the documented byte layout, tested offline against an in-memory mock that applies the program's rules.
- `MAX_BID_SOL` and `DAILY_CAP_SOL` checked in code before anything is signed, in every mode. Lamports as `bigint` throughout; no floating point touches money.
- Propose mode by default: write tools return a proposal and only `approve_proposal` signs, after re-reading the board and refusing a stale proposal.
- Append-only JSONL activity log carrying the agent's reasoning, the transaction signature and the board state either side of every write. The spend limiter reads it for the rolling 24-hour total.
- The billboard message is returned between untrusted-content markers and is never interpreted by the server.
- Operator intent file returned verbatim in every read.
- `npm run demo` walks the whole server against the mock with no network and no keys.
