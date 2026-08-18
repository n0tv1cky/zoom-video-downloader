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
# on top of the fixed script: it always sends exactly one push notification
# summarizing the outcome (what synced, or what broke and why), rather than
# either staying silent or failing invisibly in a log nobody checks. It does
# not attempt to silently fix or rewrite code itself (Write/Edit are
# disallowed below), by design: this is meant to run the sync, catch and
# explain problems, and notify you -- not to patch things without you seeing.
#
# --remote-control gives this session a stable, named Remote Control
# connection, so PushNotification below reaches your phone (not just this
# Mac's desktop notifications) and the run is viewable/attachable from the
# Claude Code mobile app while or after it runs.

set -euo pipefail

PROMPT='You are running unattended, triggered by a macOS launchd scheduled job with nobody watching this terminal -- your output only ever gets read later in a log file, if at all. This means the usual "skip the notification, the user is already watching the terminal" judgment call does NOT apply here: always send the PushNotification described below, every single run, with no exceptions.

Run the Zoom recordings sync now: node /Users/n0tv1cky/Documents/Personal/masters/scripts/zoom-recordings/download-recordings.mjs (run it with that absolute path; no need to cd anywhere -- it resolves its own config relative to the script file regardless of working directory).

Regardless of outcome, send exactly one PushNotification at the end summarizing what happened, under 200 characters, leading with the actionable part:
- If it completed cleanly (nothing new, or everything downloaded/uploaded without error): a short one-line summary, e.g. "Zoom sync: 2 new recordings uploaded" or "Zoom sync: nothing new today."
- If something failed or looked wrong (auth/credential error, the recordings sheet or schedule sheet structure looks different than expected, a Zoom share link behaves unexpectedly, the Drive upload fails, etc.): spend a little time investigating why first -- check the error output, check recent entries in the state file (~/.zoom-recordings-sync/*-state.json), check whether the sheet columns/format changed -- then notify with what broke and what I need to do about it.

Do not modify any files or code -- only diagnose and report.'

claude -p "$PROMPT" \
  --remote-control zoom-recordings-daily \
  --permission-mode bypassPermissions \
  --disallowedTools "Write,Edit,NotebookEdit" \
  --output-format text
