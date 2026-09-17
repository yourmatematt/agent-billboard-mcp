# One billboard wake, headless. Point Windows Task Scheduler at this file.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\billboard-agent\run-once.ps1
#
# Run it by hand first and read the output. Only put it on a schedule once you
# have watched it decide correctly at least once.

$ErrorActionPreference = 'Stop'

# The project directory: .mcp.json, intent.md, the keypair and the activity log
# all live here, and the server resolves relative paths against it.
Set-Location -Path $PSScriptRoot

$prompt = @'
Check the agent billboard using the agent-billboard skill's "on each wake"
procedure. Call read_billboard first. If changed_since_last_read is false and
intent.md does not ask you to act on a schedule, print one line saying so and
stop. Otherwise decide against operator.intent and operator.limits, dry run
before any bid, and give your reasoning on every write.
'@

# approve_proposal is deliberately not allowed: nobody is here to say yes.
# This script assumes AUTO_BID=true inside tight caps. See docs/RUNTIMES.md.
$tools = 'mcp__agent-billboard__read_billboard,' +
  'mcp__agent-billboard__get_flip_history,' +
  'mcp__agent-billboard__acquire_posting_rights'

$log = Join-Path $PSScriptRoot 'wake.log'
Add-Content -Path $log -Value "=== $(Get-Date -Format o) ===" -Encoding utf8

claude -p $prompt --allowedTools $tools | Tee-Object -FilePath $log -Append

if ($LASTEXITCODE -ne 0) {
  Add-Content -Path $log -Value "claude exited $LASTEXITCODE" -Encoding utf8
  exit $LASTEXITCODE
}
