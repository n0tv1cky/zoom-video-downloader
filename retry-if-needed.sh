#!/bin/bash
# Companion to daily-check.sh -- fires the same-day retry.
#
# DEPLOYED COPY: like daily-check.sh, launchd runs the copy at
# ~/.zoom-recordings-sync/retry-if-needed.sh (TCC blocks background processes
# from executing scripts under ~/Documents). Re-run after editing this file:
#   cp retry-if-needed.sh ~/.zoom-recordings-sync/retry-if-needed.sh
#
# Its own launchd job (com.n0tv1cky.zoom-recordings-retry.plist) fires this on
# a StartInterval timer. There's no clean "on wake" launchd event, but a
# StartInterval job that was due while asleep fires once on wake to catch up
# (same mechanism StartCalendarInterval uses) -- so this effectively runs
# "next time the Mac wakes" as well as periodically while it's already awake.
# The interval is short (see the plist) but nearly free: almost every firing
# is just this flag check below, with zero cost when nothing is pending.
set -euo pipefail

FLAG=~/.zoom-recordings-sync/retry-pending
[ -f "$FLAG" ] || exit 0

flag_date=$(cat "$FLAG" 2>/dev/null || true)
today=$(date +%F)

# Consume the flag immediately regardless of its date -- a stale flag (e.g.
# the Mac stayed asleep for days after the failure) shouldn't trigger a
# surprise retry well after the fact; only today's flag gets acted on.
rm -f "$FLAG"

if [ "$flag_date" = "$today" ]; then
  bash ~/.zoom-recordings-sync/daily-check.sh --retry >> ~/.zoom-recordings-sync/daily-check.log 2>&1
fi
