#!/bin/bash
# Queues macOS scheduled-wake events (via `pmset schedule wake`) for every
# config.json schedule.activeHours slot, so the
# com.n0tv1cky.zoom-recordings-sync LaunchAgent's StartCalendarInterval
# array (see install-launchd.sh) has a chance to actually fire even with
# the lid closed. Mirrors the sibling calendar-sync project's own
# schedule-wakeups.sh; see docs/background-automation.md for the general
# pattern and every caveat below in more depth.
#
# Without this, a fully-asleep Mac just misses each slot's firing entirely
# -- launchd doesn't queue missed StartCalendarInterval occurrences, it only
# catches up once on next actual wake. That's already handled safely
# (retry-if-needed.sh's same-day retry + the next slot's/tomorrow's normal
# run either way), so this script is a pure optimization for *when* the
# sync ideally runs, never a correctness dependency -- if scheduled wake
# doesn't pan out on this machine (see battery caveat below), nothing
# breaks, slots just run later than scheduled, same as before this existed.
#
# CAVEATS -- read before relying on this:
# - `pmset schedule` needs root. This script is meant to run AS root, via
#   the LaunchDaemon in com.n0tv1cky.zoom-recordings-wake-scheduler.plist
#   (installed by install-wake-scheduler.sh) -- not meant to be run
#   directly as your own user without sudo.
# - Scheduled wake events are ONE-TIME, not recurring -- `pmset schedule`
#   has no "repeat daily" primitive, and no multi-time-per-day primitive
#   either -- each slot needs its own `pmset schedule wake` call. So this
#   script has to be re-run once daily to queue that day's full set of
#   slots, which is what the nightly (00:05) LaunchDaemon is for.
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
#   after changing config.json's `schedule` block.

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node -e "
const config = JSON.parse(require('fs').readFileSync('$DEPLOY_DIR/config.json', 'utf8'));
const { intervalHours, activeHours } = config.schedule;
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const startMin = toMinutes(activeHours.start);
const endMin = toMinutes(activeHours.end);
const stepMin = intervalHours * 60;
const now = new Date();
for (let t = startMin; t <= endMin; t += stepMin) {
  const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(t / 60), t % 60, 0);
  // Skip anything already past today -- this only queues *future* slots;
  // running the script again tomorrow (via the nightly LaunchDaemon) queues
  // that day's full set fresh.
  if (when <= now) continue;
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = \`\${pad(when.getMonth() + 1)}/\${pad(when.getDate())}/\${when.getFullYear()} \${pad(when.getHours())}:\${pad(when.getMinutes())}:00\`;
  console.log(dateStr);
}
" | while read -r WHEN; do
  pmset schedule wake "$WHEN" || echo "WARNING: failed to schedule wake at $WHEN" >&2
done

# Hardcoded absolute path (not ~/.zoom-recordings-sync) deliberately -- this
# runs as root via a LaunchDaemon, and root's own $HOME is /var/root, not
# n0tv1cky's -- ~ would silently log to the wrong place.
echo "$(date): queued today's remaining wake times." >> "/Users/n0tv1cky/.zoom-recordings-sync/wake-scheduler.log"
