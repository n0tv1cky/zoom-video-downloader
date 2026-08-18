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
# on top of the fixed script: on a normal run (nothing new, or new recordings
# downloaded/uploaded cleanly) it stays silent; on a genuine failure (auth
# expired, the sheet's structure changed, a share-link format changed, etc.)
# it investigates briefly and sends exactly one push notification explaining
# what broke and what you need to do -- it does not attempt to silently fix
# or rewrite code itself (Write/Edit are disallowed below), by design: this
# is meant to catch and explain problems, not patch them without you seeing.

set -euo pipefail

PROMPT='Run the Zoom recordings sync now: node /Users/n0tv1cky/Documents/Personal/masters/scripts/zoom-recordings/download-recordings.mjs (run it with that absolute path; no need to cd anywhere -- it resolves its own config relative to the script file regardless of working directory).

If it completes with nothing new to do, or downloads/uploads everything pending without error, do NOT send a notification -- just finish quietly.

If something fails or looks wrong (auth/credential error, the recordings sheet or schedule sheet structure looks different than expected, a Zoom share link behaves unexpectedly, the Drive upload fails, etc.), spend a little time investigating why -- check the error output, check recent entries in the state file (~/.zoom-recordings-sync/*-state.json), check whether the sheet columns/format changed -- then send exactly one PushNotification summarizing what broke and what I need to do about it. Keep it under 200 characters, lead with the actionable part.

Do not modify any files or code -- only diagnose and report.'

claude -p "$PROMPT" \
  --permission-mode bypassPermissions \
  --disallowedTools "Write,Edit,NotebookEdit" \
  --output-format text
