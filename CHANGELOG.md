# Changelog

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
