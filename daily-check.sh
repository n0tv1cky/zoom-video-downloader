#!/bin/bash
# Runs the Zoom recordings sync under AI supervision, unattended (launchd).
#
# DEPLOYED COPY: launchd actually executes ~/.zoom-recordings-sync/daily-check.sh,
# not this file. macOS TCC blocks background (non-GUI) processes from executing
# scripts that live inside ~/Documents, so the runtime copy lives outside it.
# Re-run this after editing this file:
#   cp scripts/zoom-recordings/daily-check.sh ~/.zoom-recordings-sync/daily-check.sh
#
# Unlike running download-recordings.mjs directly, this gives Claude judgment
# on top of the fixed script: it diagnoses the outcome (what synced, or what
# broke and why) in plain text, rather than either staying silent or failing
# invisibly in a log nobody checks. It does not attempt to silently fix or
# rewrite code itself, by design: --allowedTools below only grants Bash (to
# run the sync + inspect logs/state) and Read -- no Write/Edit/NotebookEdit,
# so this is meant to run the sync, catch and explain problems, and report --
# not to patch things without you seeing. Restricting to exactly these tools
# (rather than just excluding the write-capable ones) also shrinks the system
# prompt's tool-schema section, which is most of every run's token cost since
# each run is a fresh, uncached session.
#
# Sending the actual phone notification is NOT one of Claude's tools here --
# the PushNotification tool turned out not to reliably reach the phone from
# an unattended `-p` run (its Remote Control pairing appears to need an
# interactive session; see git history for the debugging). iMessage-to-self
# doesn't alert either (Apple suppresses notifications for messages sent to
# yourself from one of your own signed-in devices). Both would also cost
# tokens as an extra tool call. Instead, Claude just returns its summary as
# plain text (.result below), and this script sends *that* via `osascript`
# directly -- a deterministic bash step, zero extra tokens, no LLM involved
# in the send itself.
#
# --remote-control gives this session a stable, named Remote Control
# connection so the run is viewable/attachable from the Claude Code mobile
# app while or after it runs -- unrelated to the notification path above.
#
# --model pins this to Haiku 4.5 rather than the default Sonnet. The task is
# mechanical (run a script, read its output, send one notification) and
# doesn't need Sonnet-level reasoning; Haiku is priced substantially lower
# per token, and since token *volume* here is mostly fixed system-prompt
# overhead (not task complexity), per-token price is the main lever left to
# cut cost. Trade-off: if something genuinely novel breaks (not a known
# failure mode), Haiku's diagnosis in the notification may be less sharp --
# acceptable here since it still can't touch code either way, only report.

set -euo pipefail

PHONE_NUMBER="+919148786777"

PROMPT='Run the Zoom recordings sync now: node /Users/n0tv1cky/Documents/Personal/masters/scripts/zoom-recordings/download-recordings.mjs (run it with that absolute path; no need to cd anywhere -- it resolves its own config relative to the script file regardless of working directory).

Reply with a single plain-text summary, under 200 characters, leading with the actionable part -- this is the only output that reaches me (I am not watching this run), so do not just describe what you would do, actually state the outcome:
- If it completed cleanly (nothing new, or everything downloaded/uploaded without error): a short one-line summary, e.g. "Zoom sync: 2 new recordings uploaded" or "Zoom sync: nothing new today."
- If something failed or looked wrong (auth/credential error, the recordings sheet or schedule sheet structure looks different than expected, a Zoom share link behaves unexpectedly, the Drive upload fails, etc.): spend a little time investigating why first -- check the error output, check recent entries in the state file (~/.zoom-recordings-sync/*-state.json), check whether the sheet columns/format changed -- then summarize what broke and what I need to do about it.

Do not modify any files or code -- only diagnose and report. Do not send any notification yourself -- just return the summary as your final reply.'

echo "===== $(date "+%Y-%m-%d %H:%M:%S %Z") — run start ====="

# --output-format json (instead of text) gives us the same final summary via
# .result, plus token usage and cost -- so the log can show both without a
# second, separate lookup into ~/.claude/projects/*/*.jsonl afterward.
#
# Not `claude -p ... || exit 1`: that would skip the "run end" timestamp
# below on failure, right when the log needs it most. Capture the exit code
# instead, always log the end marker, then propagate the code afterward.
set +e
raw_output=$(claude -p "$PROMPT" \
  --remote-control zoom-recordings-daily \
  --permission-mode bypassPermissions \
  --allowedTools "Bash,Read" \
  --model claude-haiku-4-5-20251001 \
  --output-format json)
claude_exit=$?
set -e

if echo "$raw_output" | jq -e . >/dev/null 2>&1; then
  summary=$(echo "$raw_output" | jq -r '.result')
  echo "$summary"
  echo "$raw_output" | jq -r '
    "[tokens] input=\(.usage.input_tokens) output=\(.usage.output_tokens) " +
    "cache_creation=\(.usage.cache_creation_input_tokens) cache_read=\(.usage.cache_read_input_tokens) " +
    "cost_usd=\(.total_cost_usd) session=\(.session_id)"
  '
else
  # claude didn't return valid JSON (e.g. crashed before producing output) --
  # fall back to logging whatever it did print, raw, and send that instead.
  summary="$raw_output"
  echo "$summary"
fi

# Plain AppleScript send, no LLM/tool call involved -- see the comment block
# up top for why this replaced PushNotification and iMessage-to-self alerts.
# Passed as script arguments (not interpolated into the AppleScript source)
# so nothing in $summary needs shell/AppleScript quote-escaping.
osascript \
  -e 'on run {msg, num}' \
  -e 'tell application "Messages" to send msg to buddy num of service 1' \
  -e 'end run' \
  -- "$summary" "$PHONE_NUMBER" >/dev/null 2>&1 \
  || echo "WARN: failed to send iMessage notification"

echo "===== $(date "+%Y-%m-%d %H:%M:%S %Z") — run end (exit $claude_exit) ====="
exit $claude_exit
