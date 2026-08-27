# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Downloads class Zoom recordings listed in a Google Sheet (before their share links expire) and uploads them to Drive, named from the sheet's course code / date / faculty columns. Runs unattended once a day via `launchd`, and can also be run by hand.

This repo was split out of a personal monorepo (`~/Documents/Personal/masters`) on 2026-08-27, with full commit history preserved via `git filter-repo`. See "Split history" below for what that means for secrets handling.

**Git workflow:** this repo has a real GitHub remote (`origin`, `n0tv1cky/zoom-video-downloader`). Commit as normal, but **never push without being explicitly asked** — a push here is visible to whoever has access to that GitHub repo.

## Split history / secrets (read before touching config or docs)

`config.json` in this repo contains only **placeholder** values (`<YOUR_...>`) for anything sensitive — the recordings-sheet ID, the Drive upload folder ID, the institute email, and the Chrome profile email hint. The real values live in `config.local.json`, which is gitignored and deep-merged over `config.json` at load time by `lib/configLocal.mjs` (see `loadConfig()` in `download-recordings.mjs` and `send-report.mjs`).

**Never put a real Sheet ID, Drive folder ID, or email address directly into `config.json`, code, or `README.md`** — put it in `config.local.json` instead. The pre-split history had these baked into `config.json` and README examples; that history was scrubbed with `git filter-repo --replace-text` when this repo was extracted, and this repo is meant to stay clean going forward. If you're ever unsure whether a value is sensitive, check `config.local.json`'s existing keys — anything already extracted there is the pattern to follow for new fields.

`oauth-client.json` (Google Cloud "Desktop app" OAuth client secret) is gitignored and has never been committed, in this repo or its monorepo predecessor.

## Commands

Plain Node ESM script — no build step, no bundler, no lint config, no test suite.

```bash
npm install
npm run sync              # node download-recordings.mjs
npm run sync:dry          # --dry-run: show what would download/upload, no writes
node download-recordings.mjs --headed   # one-time interactive login, or to re-login if the session expires
node download-recordings.mjs --limit N  # process at most N pending sessions
node download-recordings.mjs --config path/to/other.json  # e.g. for a future term
```

**Redeploying `daily-check.sh` and `retry-if-needed.sh` after editing them:** launchd runs copies of these outside `~/Documents` (macOS TCC blocks background/non-GUI processes from executing scripts that live inside `~/Documents`). After any edit, re-copy:
```bash
cp daily-check.sh ~/.zoom-recordings-sync/daily-check.sh
cp retry-if-needed.sh ~/.zoom-recordings-sync/retry-if-needed.sh
```
Editing the repo copy alone has no effect on the live unattended job until this is done. The deployed copies (and the two `launchd` LaunchAgents that invoke them) still reference this repo's absolute path (`/Users/n0tv1cky/Documents/Personal/masters/projects/zoom-recordings/...`) — if this repo is ever moved again, both the deployed scripts *and* `install-wake-scheduler.sh`'s `REPO_DIR` need updating and redeploying, or the unattended job silently breaks (this happened during the 2026-08-27 split and had to be fixed by hand).

## OAuth credentials

`oauth-client.json` sits in the repo root, gitignored, never committed — treat it as a secret if you ever touch it.

Cached user token lives outside the repo, at `~/.zoom-recordings-sync/google-oauth-token.json`. This is an OAuth **testing-status** app token — Google can expire it (commonly after ~7 days unused, or without periodic re-consent), which shows up as an auth failure requiring one interactive re-login (`node download-recordings.mjs --headed`), not a code bug.

There's a **second, separate token** just for sending the daily report email: `~/.zoom-recordings-sync/gmail-token.json`, scoped to `gmail.send` only, obtained via `lib/gmailAuth.mjs`'s own local-server OAuth flow (not `@google-cloud/local-auth`, and not merged into the Sheets/Drive token above) — see that file's header comment and `docs/email-notifications.md` for why a new scope needs a brand-new token file rather than being added to an existing one.

## Architecture

**Pipeline:** read the recordings Google Sheet (real Sheets API, not scraped) → for each row needing a fetch, drive a headless real Chrome (`channel: "chrome"`, not Puppeteer's bundled binary — see below) to the Zoom share link, trigger playback to expose the signed video URL, then download via Node's own `fetch` replaying the page's cookies (not the browser's fetch — buffering large video bodies inside the browser process was unreliable) → upload to Drive → track per-recording status in a state file keyed by Zoom link.

Key design points, each the result of a real bug found and fixed (see git log for the specifics — each is a small case study worth reading before touching that area):

- **Dedup/idempotency**: `stateFile` (`~/.zoom-recordings-sync/*-state.json`) tracks `{download, upload}` status per Zoom link (or `link#clip0`/`#clip1` for combined-link rows — see below). Re-running is always safe; only pending work happens.
- **Atomic downloads**: `downloadToFile()` streams to a `.partial` sibling and renames onto the real path only after the transfer fully succeeds. An earlier version wrote directly to the final path, so a killed/interrupted download left a truncated file there that the dedup check (`fs.existsSync`) then trusted as "already downloaded" and uploaded as-is.
- **Combined-link rows**: a single Zoom link can cover two back-to-back class sessions recorded as separate clips (sheet marks this by slash-joining course codes, e.g. `DSM 101 (1)/ ME (2)`). `expandRowIntoSessions` splits these into independent sessions sharing one link; `grabClipUrls` walks Zoom's own multi-clip player by seeking each clip near its end to trigger the next clip's signed URL to load. **When nobody stops/restarts the recording between the two classes, Zoom produces one continuous clip instead of two** (hit live 2026-08-27, `DSM 101 (5)/DSM 102 (2)`) — currently this just fails the second session forever; `docs/continuous-recording-splitting.md` has the planned (not yet built) fix: schedule-narrowed audio-silence detection to find the cut point automatically, falling back to a one-time manual timestamp only when no clean silence gap is found.
- **Merged cells**: the sheet can have vertically merged Date/S.No/link-window cells for a same-day second class. The Sheets API only returns a value for a merge's top-left cell, so `parseRows()` forward-fills a blank Date from the last non-blank one seen.
- **Subject code resolution**: the sheet uses short abbreviations (`ME`, `MC`, ...); `config.json`'s `subjectCodeMap` maps these to canonical `DSM <N>` codes (from the schedule sheet's own course legend). An unmapped abbreviation degrades to being used as-is rather than breaking the run. The full code/title/instructor table (and the real formatting inconsistencies across sheets that motivate this design) lives in the monorepo's `docs/course-codes.md`, not in this repo — it's a shared cross-project reference, not zoom-recordings-specific.
- **Browser launch** (`launchBrowser()`): headless by default, using the real installed Google Chrome app (`channel: "chrome"`) against a dedicated automation profile (`chromeProfileDir`) — deliberately *not* the user's everyday Chrome profile (no need to quit anything) and *not* Puppeteer's bundled "Chrome for Testing" binary (that binary's identity changes on every Puppeteer update, which was causing macOS to repeatedly re-prompt for TCC permissions). Pass `--headed` for the one-time interactive login or to re-login after the saved session expires; a headless run that unexpectedly hits a login page fails immediately with a clear message rather than hanging.
- **`useSystemProfile: true`** (currently off, `config.chrome.useSystemProfile: false`) is an alternate path that drives your actual everyday Chrome profile via a synced snapshot — requires fully quitting Chrome first, so it's not used for the unattended job.

**Unattended daily automation** (`daily-check.sh`, two `launchd` LaunchAgents): runs the sync synchronously in bash (`caffeinate -i node download-recordings.mjs > log`, no timeout) — an earlier design had Claude invoke the sync itself via its Bash tool, which broke twice when the sync outran the tool-call timeout and Claude declared itself "done" while the process was still running, killing it mid-upload. `send-report.mjs` then reads the finished log, matches it against a small closed set of known non-transient error strings (`NON_TRANSIENT_PATTERNS`) to decide same-day retry eligibility (fail-open otherwise — see `README.md`'s "Same-day retry" section), and emails a report via the Gmail API using its own gmail-send-only OAuth token (`lib/gmailAuth.mjs`, separate from the Sheets/Drive token, see that file's header for why). No LLM/`claude -p` call and no iMessage/`osascript` are involved anywhere in this pipeline — both were replaced because the "diagnosis" was always plain pattern-matching, and iMessage-to-self never produced a phone alert banner in the first place. See `docs/email-notifications.md` for the general Gmail-API-send pattern reused here (and in the sibling `calendar-sync` project).

**Optional lid-closed wake workaround** (`schedule-wakeup.sh` + `install-wake-scheduler.sh`, a root `LaunchDaemon`, not installed by default): closing the lid is full system sleep, so a missed 9am `StartCalendarInterval` firing just catches up once on next wake rather than queueing — see `docs/background-automation.md` for the general pattern (this mirrors the sibling `calendar-sync` project's own wake scheduler). `sudo ./install-wake-scheduler.sh` queues a `pmset schedule wake` event nightly for `config.json`'s `dailyRunTime`. Genuinely optional: the core job is already safe without it (same-day retry + idempotent re-runs), and scheduled wake itself is only reliable on AC power, not battery.

Full detail on all of the above (including things not summarized here) is in `README.md` — read it before making non-trivial changes to this tool.
