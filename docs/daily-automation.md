# Unattended runs on macOS (optional)

Once [SETUP.md](SETUP.md) works by hand, you can have macOS run the sync on a
schedule and email you a report. Skip this page if you're happy running
`npm run sync` yourself.

## What runs

```
launchd (every intervalHours within activeHours, from config.json "schedule")
  -> ~/.zoom-recordings-sync/daily-check.sh
       -> caffeinate -i node download-recordings.mjs > last-sync-output.log
       -> node send-report.mjs <exit code> last-sync-output.log
            emails a report and prints RETRY or NO-RETRY
       -> on RETRY: writes today's date to ~/.zoom-recordings-sync/retry-pending

launchd (every 15 min)
  -> ~/.zoom-recordings-sync/retry-if-needed.sh
       -> if retry-pending is set for today: runs daily-check.sh --retry once
```

- **Why the scripts are copied out of the repo.** macOS (TCC) won't let a
  background job *execute* a script that lives under `~/Documents`, so the
  scripts launchd runs are deployed copies in `~/.zoom-recordings-sync/`.
  Re-deploy after editing them (see below).
- **No live AI calls.** The sync runs as a plain blocking bash command, and the
  report is plain log parsing.
- **Report email.** It uses its own `gmail.send`-only token
  (`lib/gmailAuth.mjs`), sent to `notifications.toEmail`. The subject line
  leads with the outcome, for example `Zoom sync: 2 uploaded` or
  `Zoom sync FAILED (exit 1)`.
- **Retries.** `send-report.mjs` returns NO-RETRY only for known permanent
  errors (`NON_TRANSIENT_PATTERNS`: expired login, missing client file, and so
  on). Anything else gets one same-day retry. If a new permanent error shows
  up, add its message to that list.

## Install

1. **Check the paths.** The installers find your clone from where they live,
   and `install-launchd.sh` points the deployed `daily-check.sh` at it, so you
   edit nothing. The exceptions are the job names (`com.n0tv1cky.…`) and the
   optional wake scheduler's home-folder paths (see the end of this page),
   which are written in.
2. **Install the scheduled job.** This deploys `daily-check.sh` and generates
   the LaunchAgent from `config.json`'s `schedule` block:
   ```bash
   ./install-launchd.sh
   ```
3. **Install the retry job:**
   ```bash
   cp retry-if-needed.sh ~/.zoom-recordings-sync/retry-if-needed.sh
   chmod +x ~/.zoom-recordings-sync/retry-if-needed.sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.n0tv1cky.zoom-recordings-retry.plist
   ```
4. **Set up the report email.** The first `send-report.mjs` run opens a browser
   to grant `gmail.send` (see [email-notifications.md](email-notifications.md)).

Re-run `./install-launchd.sh` after editing `daily-check.sh` or the `schedule`
block. After editing `retry-if-needed.sh`, copy it again.

## Everyday commands

```bash
tail -f ~/.zoom-recordings-sync/daily-check.log                       # recent runs
launchctl kickstart gui/$(id -u)/com.n0tv1cky.zoom-recordings-sync    # run now
launchctl print gui/$(id -u)/com.n0tv1cky.zoom-recordings-sync        # status
launchctl bootout gui/$(id -u)/com.n0tv1cky.zoom-recordings-sync      # stop
```

## Waking a sleeping Mac (optional)

With the lid closed, a missed slot runs once on the next wake. Nothing is
lost, it just runs late. To wake the Mac at each slot instead, install the
root wake scheduler. It queues a `pmset schedule wake` event for each slot
every night:

```bash
sudo ./install-wake-scheduler.sh
```

This runs as root, so `$HOME` isn't yours. Change the home-folder paths
(`DEPLOY_DIR` in `install-wake-scheduler.sh`, and the log path in
`schedule-wakeup.sh`) to your own first. Scheduled wake is only reliable on AC
power. Read the header of
`schedule-wakeup.sh` before installing; it also explains how to uninstall.
For the general pattern, see
[background-automation.md](background-automation.md).
