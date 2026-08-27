#!/bin/bash
# Queues a macOS scheduled-wake event (via `pmset schedule wake`) for
# config.json's dailyRunTime, so the com.n0tv1cky.zoom-recordings-sync
# LaunchAgent's StartCalendarInterval (currently hand-set to 09:00 in that
# plist -- keep both in sync if you ever change one) has a chance to
# actually fire even with the lid closed. Distilled from
# scripts/calendar-sync's own wake-scheduler; see docs/background-automation.md
# for the general pattern and every caveat below in more depth.
#
# Without this, a fully-asleep Mac just misses the 9am firing entirely --
# launchd doesn't queue missed StartCalendarInterval occurrences, it only
# catches up once on next actual wake. That's already handled safely
# (retry-if-needed.sh's same-day retry + tomorrow's normal run either way),
# so this script is a pure optimization for *when* the sync ideally runs,
# never a correctness dependency -- if scheduled wake doesn't pan out on
# this machine (see battery caveat below), nothing breaks, it just runs
# later than 9am, same as before this existed.
#
# CAVEATS -- read before relying on this:
# - `pmset schedule` needs root. This script is meant to run AS root, via
#   the LaunchDaemon in com.n0tv1cky.zoom-recordings-wake-scheduler.plist
#   (installed by install-wake-scheduler.sh) -- not meant to be run
#   directly as your own user without sudo.
# - Scheduled wake events are ONE-TIME, not recurring -- `pmset schedule`
#   has no "repeat daily" primitive for an arbitrary time. So this script
#   has to be re-run once daily to queue the *next* wake, which is what the
#   nightly (00:05) LaunchDaemon is for.
# - Reliability is NOT guaranteed lid-closed-on-battery. Apple's scheduled
#   wake is documented and generally reliable while plugged into AC power;
#   on battery alone it's inconsistent across Mac models, with no clean way
#   to verify from software alone. This is a real platform limit, not a bug
#   to keep chasing.
# - A scheduled wake only wakes a SLEEPING Mac -- it does nothing for a
#   fully powered-off one.
# - Reads config.json from ITS OWN directory (a deployed copy), not from
#   ~/Documents/.../scripts/zoom-recordings/config.json -- confirmed live
#   in calendar-sync's build of this same pattern: even a plain file *read*
#   of a path under ~/Documents fails with EPERM for a bare root
#   LaunchDaemon (no Terminal/WindowServer session to inherit a TCC grant
#   from), not just "executing a script located there." install-wake-
#   scheduler.sh copies config.json here on every (re)install -- re-run it
#   after changing config.json's dailyRunTime.

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WHEN=$(node -e "
const config = JSON.parse(require('fs').readFileSync('$DEPLOY_DIR/config.json', 'utf8'));
const [hour, minute] = config.dailyRunTime.split(':').map(Number);
const now = new Date();
let when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
// If today's slot has already passed, queue tomorrow's instead -- this
// script runs nightly at 00:05, well before any reasonable dailyRunTime,
// so this branch is mainly for a manual/RunAtLoad re-run later in the day.
if (when <= now) when = new Date(when.getTime() + 24 * 60 * 60 * 1000);
const pad = (n) => String(n).padStart(2, '0');
console.log(\`\${pad(when.getMonth() + 1)}/\${pad(when.getDate())}/\${when.getFullYear()} \${pad(when.getHours())}:\${pad(when.getMinutes())}:00\`);
")

pmset schedule wake "$WHEN" || echo "WARNING: failed to schedule wake at $WHEN" >&2

# Hardcoded absolute path (not ~/.zoom-recordings-sync) deliberately -- this
# runs as root via a LaunchDaemon, and root's own $HOME is /var/root, not
# n0tv1cky's -- ~ would silently log to the wrong place.
echo "$(date): queued wake at $WHEN." >> "/Users/n0tv1cky/.zoom-recordings-sync/wake-scheduler.log"
