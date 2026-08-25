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
# on top of the fixed script: after the sync itself has already run (see
# "THE SYNC RUNS DIRECTLY IN BASH" below for why Claude doesn't invoke it),
# Claude reads its output and diagnoses the outcome (what synced, or what
# broke and why) in plain text, rather than either staying silent or failing
# invisibly in a log nobody checks. It does not attempt to silently fix or
# rewrite code itself, by design: --allowedTools below only grants Bash (to
# inspect logs/state) and Read -- no Write/Edit/NotebookEdit, so this is
# meant to catch and explain problems, and report -- not to patch things
# without you seeing. Restricting to exactly these tools (rather than just
# excluding the write-capable ones) also shrinks the system prompt's
# tool-schema section, which is most of every run's token cost since each
# run is a fresh, uncached session.
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
#
# SAME-DAY RETRY: if today's scheduled (non-retry) run fails, it writes
# today's date to $RETRY_FLAG below. retry-if-needed.sh (its own launchd job,
# see com.n0tv1cky.zoom-recordings-retry.plist) checks that flag on a timer
# that also catches up right after the Mac wakes from sleep, and if it's set
# for today, calls this script again with --retry. A --retry run does NOT
# re-arm the flag on failure, so this is at most one extra attempt per day --
# a second same-day failure is left for tomorrow's normal scheduled run
# (state file already makes that safe/idempotent; see README).
#
# THE SYNC RUNS DIRECTLY IN BASH, NOT AS SOMETHING CLAUDE INVOKES. Two
# earlier designs had Claude run download-recordings.mjs itself via the Bash
# tool, and both broke the same way: the sync can legitimately take longer
# than any Bash-tool timeout (tried 60s, then the 600s max), the tool call
# gets backgrounded, and Haiku declared "waiting for completion"/"monitor
# streaming" as its FINAL reply instead of actually blocking on the result --
# which ends the `-p` session and kills the still-running sync mid-upload
# (confirmed via the state file: downloads left half-finished, one file
# orphaned on disk with no state entry at all, on 2026-08-25). No prompt
# wording fixed this reliably because it's not a judgment call, it's a hard
# tool-timeout mechanic. So the sync now runs as a plain synchronous bash
# command below -- no timeout, no backgrounding possible -- and Claude's job
# shrinks to reading the *already-finished* output and summarizing it, which
# has no failure mode where ending its reply early loses work.

set -euo pipefail

PHONE_NUMBER="+919148786777"
RETRY_FLAG=~/.zoom-recordings-sync/retry-pending
SYNC_LOG=~/.zoom-recordings-sync/last-sync-output.log
is_retry=false
[ "${1:-}" = "--retry" ] && is_retry=true

retry_tag=""
if $is_retry; then retry_tag=" (retry)"; fi
echo "===== $(date "+%Y-%m-%d %H:%M:%S %Z") — run start${retry_tag} ====="

# caffeinate -i wraps the actual sync: on 2026-08-20 the laptop was awake
# when launchd fired at 9am but went to idle sleep partway through, killing
# an in-flight request. -i (not -s) only blocks *idle* sleep for the wrapped
# process's lifetime and releases automatically when it exits -- it won't
# stop a manual lid-close/power-button sleep, and it doesn't hold the
# machine awake outside of this one call. No artificial timeout here (unlike
# the Bash tool's), so a long download/upload just runs to completion.
set +e
caffeinate -i node /Users/n0tv1cky/Documents/Personal/masters/scripts/zoom-recordings/download-recordings.mjs > "$SYNC_LOG" 2>&1
sync_exit=$?
set -e

PROMPT="The Zoom recordings sync already ran (in plain bash, not something you need to invoke) and finished with exit code $sync_exit. Its full output is at $SYNC_LOG -- read that file to see what happened.

Reply with a single plain-text summary, under 200 characters, leading with the actionable part -- this is the only output that reaches me (I am not watching this run), so do not just describe what you would do, actually state the outcome:
- If it completed cleanly (nothing new, or everything downloaded/uploaded without error): a short one-line summary, e.g. \"Zoom sync: 2 new recordings uploaded\" or \"Zoom sync: nothing new today.\"
- If something failed or looked wrong (auth/credential error, the recordings sheet or schedule sheet structure looks different than expected, a Zoom share link behaves unexpectedly, the Drive upload fails, etc.): spend a little time investigating why first -- check the log, check recent entries in the state file (~/.zoom-recordings-sync/*-state.json), check whether the sheet columns/format changed -- then summarize what broke and what I need to do about it.

Do not modify any files or code -- only diagnose and report. Do not send any notification yourself -- just return the summary as your final reply."

# --output-format json (instead of text) gives us the same final summary via
# .result, plus token usage and cost -- so the log can show both without a
# second, separate lookup into ~/.claude/projects/*/*.jsonl afterward.
#
# Not `claude -p ... || exit 1`: that would skip the "run end" timestamp
# below on failure, right when the log needs it most. Capture the exit code
# instead, always log the end marker, then propagate the code afterward.
#
# This call is now purely diagnostic (read a finished log, reply) -- no
# reason to expect it to run long enough to hit a Bash-tool timeout, but the
# exit code still gets checked below the same way as before regardless.
set +e
raw_output=$(claude -p "$PROMPT" \
  --remote-control zoom-recordings-daily \
  --permission-mode bypassPermissions \
  --allowedTools "Bash,Read" \
  --model claude-haiku-4-5-20251001 \
  --output-format json)
claude_exit=$?
set -e
# The sync itself failing is the real signal for the retry mechanism below --
# a Claude-side error (e.g. it crashed) shouldn't mask a sync that actually
# succeeded, and vice versa.
if [ "$sync_exit" -ne 0 ] && [ "$claude_exit" -eq 0 ]; then claude_exit=$sync_exit; fi

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

if [ "$claude_exit" -ne 0 ] && ! $is_retry; then
  date +%F > "$RETRY_FLAG"
  echo "Same-day retry queued (fires next wake/check via retry-if-needed.sh)."
fi

echo "===== $(date "+%Y-%m-%d %H:%M:%S %Z") — run end${retry_tag} (exit $claude_exit) ====="
exit $claude_exit
