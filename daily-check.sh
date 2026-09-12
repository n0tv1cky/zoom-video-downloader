#!/bin/bash
# Runs the Zoom recordings sync unattended (launchd), then emails a report.
#
# DEPLOYED COPY: launchd actually executes ~/.zoom-recordings-sync/daily-check.sh,
# not this file. macOS TCC blocks background (non-GUI) processes from executing
# scripts that live inside ~/Documents, so the runtime copy lives outside it.
# Re-run this after editing this file:
#   cp scripts/zoom-recordings/daily-check.sh ~/.zoom-recordings-sync/daily-check.sh
#
# THIS USED TO SHELL OUT TO `claude -p` TO SUMMARIZE THE LOG AND SEND AN
# iMESSAGE. Both are gone. Two independent reasons:
#
# 1. iMessage-to-self silently doesn't alert (Apple suppresses notifications
#    for messages sent to yourself from one of your own signed-in devices),
#    and PushNotification/Remote Control wasn't reliably reachable from an
#    unattended `-p` run either (its pairing needs an interactive session).
#    Email has none of these delivery quirks.
# 2. The Claude call's only real job -- read the finished log, summarize it,
#    and decide if a same-day retry is worth queuing -- turned out to be
#    plain pattern-matching against a small, closed set of error strings
#    download-recordings.mjs itself throws, not something that ever actually
#    needed LLM judgment. send-report.mjs does that matching directly now
#    (see its NON_TRANSIENT_PATTERNS list), at zero cost/latency and with no
#    dependency on a `claude` install or API key on this machine.
#
# THE SYNC STILL RUNS DIRECTLY IN BASH, NOT VIA ANY AI TOOL CALL. An earlier
# design had Claude run download-recordings.mjs itself via its Bash tool, and
# broke twice the same way: the sync can legitimately outrun any Bash-tool
# timeout (tried 60s, then the 600s max), the tool call gets backgrounded,
# and the model declared "waiting for completion" as its FINAL reply instead
# of blocking on the result -- which ended the session and killed the
# still-running sync mid-upload (confirmed via the state file: downloads left
# half-finished, one file orphaned on disk with no state entry at all, on
# 2026-08-25). Running the sync as a plain synchronous bash command has no
# such timeout and no such failure mode.

set -euo pipefail

RETRY_FLAG=~/.zoom-recordings-sync/retry-pending
SYNC_LOG=~/.zoom-recordings-sync/last-sync-output.log
is_retry=false
[ "${1:-}" = "--retry" ] && is_retry=true

retry_tag=""
if $is_retry; then retry_tag=" (retry)"; fi
echo "===== $(date "+%Y-%m-%d %H:%M:%S %Z") — run start${retry_tag} ====="

# Safety net, not the primary mechanism: install-launchd.sh generates a
# StartCalendarInterval array that only fires launchd within
# config.json's schedule.activeHours in the first place (see that script's
# header), so the Mac genuinely shouldn't even wake up outside the window.
# This re-checks the same window at runtime anyway -- same belt-and-
# suspenders pattern as the sibling calendar-sync project's own
# isWithinActiveHours() -- to stay correct against a stale/unregenerated
# plist, a manual `launchctl kickstart`, or RunAtLoad firing right after
# a scheduled run. Reads config.json straight from this repo path (not a
# deployed copy) -- already proven safe here, since daily-check.sh already
# invokes download-recordings.mjs/send-report.mjs the same way.
IN_ACTIVE_HOURS=$(node -e "
const config = require('/Users/n0tv1cky/Documents/Personal/masters/projects/zoom-recordings/config.json');
const { start, end } = config.schedule.activeHours;
const now = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
console.log(now >= start && now <= end ? 'yes' : 'no');
")
if [ "$IN_ACTIVE_HOURS" != "yes" ]; then
  echo "Outside config.json's schedule.activeHours -- skipping this run."
  echo "===== $(date "+%Y-%m-%d %H:%M:%S %Z") — run end${retry_tag} (skipped, outside active hours) ====="
  exit 0
fi

# caffeinate -i wraps the actual sync: on 2026-08-20 the laptop was awake
# when launchd fired at 9am but went to idle sleep partway through, killing
# an in-flight request. -i (not -s) only blocks *idle* sleep for the wrapped
# process's lifetime and releases automatically when it exits -- it won't
# stop a manual lid-close/power-button sleep, and it doesn't hold the
# machine awake outside of this one call. No artificial timeout here (unlike
# the Bash tool's), so a long download/upload just runs to completion.
#
# download-recordings.mjs runs headless by default now (real Google Chrome
# via channel: "chrome", no visible window) -- so this no longer needs the
# lid open at 9am, only awake (which caffeinate -i above still can't
# guarantee against a manual lid-close, only idle sleep).
set +e
# ZOOM_SYNC_SKIP_AUTO_REPORT tells download-recordings.mjs not to email its
# own report -- this script already captures the same output to $SYNC_LOG
# and calls send-report.mjs itself below, with its own retry-tracking logic.
# Without this, a scheduled run would get double-emailed (once by
# download-recordings.mjs's own auto-report, once by this script).
ZOOM_SYNC_SKIP_AUTO_REPORT=1 caffeinate -i node /Users/n0tv1cky/Documents/Personal/masters/projects/zoom-recordings/download-recordings.mjs > "$SYNC_LOG" 2>&1
sync_exit=$?
set -e

echo "----- sync finished (exit $sync_exit); generating report -----"

# send-report.mjs reads $SYNC_LOG, emails a report, and prints exactly one
# line -- RETRY or NO-RETRY -- which is all we consume from stdout here.
# Its own diagnostic/warning output goes to stderr so it shows up in this
# log without contaminating that one line.
set +e
retry_verdict=$(node /Users/n0tv1cky/Documents/Personal/masters/projects/zoom-recordings/send-report.mjs "$sync_exit" "$SYNC_LOG" $($is_retry && echo --retry))
report_exit=$?
set -e
echo "Report verdict: ${retry_verdict:-<none, report script failed with exit $report_exit>}"

# SAME-DAY RETRY: gated on send-report.mjs's own RETRY/NO-RETRY verdict
# alone, NOT on $sync_exit -- download-recordings.mjs only exits non-zero on
# a fatal crash, but a per-recording failure (one bad Zoom link) is
# non-fatal by design and leaves $sync_exit at 0 even though the SUMMARY
# line's fail count is > 0 (confirmed live 2026-08-30: a Navigation timeout
# on one link, 2 other recordings uploaded fine in the same exit-0 run).
# Gating on $sync_exit alone silently skipped same-day retry for exactly
# that case. send-report.mjs already accounts for both $sync_exit and the
# SUMMARY fail count when it prints RETRY/NO-RETRY, so trust that verdict
# directly here.
#
# retry-if-needed.sh (its own launchd job, see
# com.n0tv1cky.zoom-recordings-retry.plist) checks $RETRY_FLAG on a timer
# that also catches up right after the Mac wakes from sleep, and if it's set
# for today, calls this script again with --retry. A --retry run does NOT
# re-arm the flag on failure, so this is at most one extra attempt per day
# -- a second same-day failure is left for tomorrow's normal scheduled run
# (state file already makes that safe/idempotent; see README).
if ! $is_retry; then
  if [ "$retry_verdict" = "RETRY" ]; then
    date +%F > "$RETRY_FLAG"
    echo "Same-day retry queued (fires next wake/check via retry-if-needed.sh)."
  else
    echo "No same-day retry needed."
  fi
fi

echo "===== $(date "+%Y-%m-%d %H:%M:%S %Z") — run end${retry_tag} (exit $sync_exit) ====="
exit $sync_exit
