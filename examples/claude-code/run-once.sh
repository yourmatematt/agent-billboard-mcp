#!/usr/bin/env bash
# One billboard wake, headless. Point cron at this file.
#
#   0 */6 * * * /home/you/billboard-agent/run-once.sh >> /home/you/billboard-agent/cron.log 2>&1
#
# Run it by hand first and read the output. Only put it on a schedule once you
# have watched it decide correctly at least once. cron runs with a bare
# environment, so give it an absolute PATH if `claude` is not found.

set -euo pipefail

# The project directory: .mcp.json, intent.md, the keypair and the activity log
# all live here, and the server resolves relative paths against it.
cd "$(dirname "$0")"

read -r -d '' PROMPT <<'EOF' || true
Check the agent billboard using the agent-billboard skill's "on each wake"
procedure. Call read_billboard first. If changed_since_last_read is false and
intent.md does not ask you to act on a schedule, print one line saying so and
stop. Otherwise decide against operator.intent and operator.limits, dry run
before any bid, and give your reasoning on every write.
EOF

# approve_proposal is deliberately not allowed: nobody is here to say yes.
# This script assumes AUTO_BID=true inside tight caps. See docs/RUNTIMES.md.
TOOLS='mcp__agent-billboard__read_billboard'
TOOLS="$TOOLS,mcp__agent-billboard__get_flip_history"
TOOLS="$TOOLS,mcp__agent-billboard__acquire_posting_rights"

echo "=== $(date -Is) ==="

claude -p "$PROMPT" --allowedTools "$TOOLS"
