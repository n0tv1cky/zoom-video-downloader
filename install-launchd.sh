#!/bin/bash
# Deploys daily-check.sh outside ~/Documents (required -- TCC blocks a
# background process from executing a script that lives inside it) and
# (re)installs the com.n0tv1cky.zoom-recordings-sync LaunchAgent. Run this
# after any change to daily-check.sh, or after changing config.json's
# `schedule` block (intervalHours or activeHours) -- the StartCalendarInterval
# array below is generated from those values, so it has to be regenerated
# whenever either changes.
#
# Fires ONLY at exact intervalHours steps within activeHours (e.g. 08:00,
# 12:00, 16:00, 20:00 for the default 4h/08:00-22:00) via an array of
# StartCalendarInterval entries -- not a generic recurring StartInterval that
# would also fire outside the window. This means the Mac genuinely doesn't
# even wake up outside active hours, not just "wakes up and no-ops" --
# daily-check.sh's own activeHours re-check is still there too, as a safety
# net for a stale plist or a manual/RunAtLoad firing. Mirrors the sibling
# calendar-sync project's own install-launchd.sh; see
# docs/background-automation.md for the general pattern.
#
# CAVEAT: StartCalendarInterval fires against the *system clock's* time
# zone, not any config value -- fine as long as this Mac's system timezone
# stays what it is now, but worth knowing if this is ever deployed
# elsewhere.
#
# Does NOT touch the retry-checker LaunchAgent
# (com.n0tv1cky.zoom-recordings-retry.plist) -- that one already polls on a
# fixed short StartInterval regardless of activeHours, see retry-if-needed.sh.
#
# If the wake-scheduler LaunchDaemon is installed (see
# install-wake-scheduler.sh), re-run that (as root) too after changing
# config.json's `schedule` block -- it queues one `pmset schedule wake` per
# activeHours slot and needs its own deployed config.json copy refreshed.

set -euo pipefail

# This clone's location (the script lives at the repo root).
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$HOME/.zoom-recordings-sync"
PLIST_LABEL="com.n0tv1cky.zoom-recordings-sync"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

mkdir -p "$DEPLOY_DIR"
# daily-check.sh is written with the original author's repo path; the
# deployed copy is pointed at this clone instead (a no-op on that machine).
sed "s#/Users/n0tv1cky/Documents/Personal/masters/projects/zoom-recordings#${REPO_DIR}#g" "$REPO_DIR/daily-check.sh" > "$DEPLOY_DIR/daily-check.sh"
chmod +x "$DEPLOY_DIR/daily-check.sh"

# Emits the <dict>Hour/Minute</dict> entries for every step from
# activeHours.start to .end (inclusive), one per line, ready to drop into
# StartCalendarInterval's array. Node (not bash arithmetic) because bash has
# no clean HH:MM parsing.
CALENDAR_INTERVALS=$(node -e "
const config = require('$REPO_DIR/config.json');
const { intervalHours, activeHours } = config.schedule;
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const startMin = toMinutes(activeHours.start);
const endMin = toMinutes(activeHours.end);
const stepMin = intervalHours * 60;
const entries = [];
for (let t = startMin; t <= endMin; t += stepMin) {
  entries.push(\`    <dict><key>Hour</key><integer>\${Math.floor(t / 60)}</integer><key>Minute</key><integer>\${t % 60}</integer></dict>\`);
}
console.log(entries.join('\n'));
")

INTERVAL_HOURS=$(node -e "console.log(require('$REPO_DIR/config.json').schedule.intervalHours)")
ACTIVE_START=$(node -e "console.log(require('$REPO_DIR/config.json').schedule.activeHours.start)")
ACTIVE_END=$(node -e "console.log(require('$REPO_DIR/config.json').schedule.activeHours.end)")

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${DEPLOY_DIR}/daily-check.sh</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/n0tv1cky/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>/Users/n0tv1cky</string>
    </dict>

    <key>StartCalendarInterval</key>
    <array>
${CALENDAR_INTERVALS}
    </array>

    <key>StandardOutPath</key>
    <string>${DEPLOY_DIR}/daily-check.log</string>

    <key>StandardErrorPath</key>
    <string>${DEPLOY_DIR}/daily-check.log</string>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

echo "Installed. launchd fires every ${INTERVAL_HOURS}h between ${ACTIVE_START} and ${ACTIVE_END} (config.json's schedule.intervalHours / schedule.activeHours) -- no wakeups outside that window."
echo "Logs: ${DEPLOY_DIR}/daily-check.log"
