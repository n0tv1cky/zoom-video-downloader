# Zoom recordings sync

Downloads class Zoom recordings listed in a Google Sheet before their share
links expire (your institute's plan doesn't expose a Download button, but the
signed video URL is reachable from an authenticated browser session), then
uploads each one to a Google Drive folder. The sheet itself is read via the
real Google Sheets API (your own OAuth login), not by scraping — only the
Zoom side needs a browser.

Files are named from the sheet's own columns and organized into one folder
**per subject** (all sessions of that subject together, session number
folded into the filename instead), e.g.:

```
docs/recordings/videos/MSDSM_Batch6_Term1/
  DSM-107/
    DSM-107-1_2026-08-14_Karthikeya-Naraparaju.mp4
    DSM-107-2_2026-08-17_Karthikeya-Naraparaju.mp4
  DSM-101/
    DSM-101-1_2026-08-17_Suman-Majumdar.mp4
```

Set `"organizeByCourse": false` in `config.json` to keep everything in one
flat folder instead.

## Subject code standardization

The recordings sheet uses each subject's short-form abbreviation (e.g. `ME
(2)`), but the program's real course codes are the `DSM <N>` numbers from
the [schedule sheet](https://docs.google.com/spreadsheets/d/<YOUR_SCHEDULE_SHEET_ID>)'s
course legend table (further down that sheet, past the daily timetable) —
some subjects already appear in that canonical form directly (`DSM 101`,
`DSM 102`, `DSM 103`), others only by abbreviation (`ME` = `DSM 107`, `MC` =
`DSM 104`, etc.). `config.json`'s `subjectCodeMap` maps abbreviation ->
canonical code; the script resolves every session's code through it before
naming folders/files, so `ME (2)` becomes folder `DSM-107`, filename
`DSM-107-2_...`. An abbreviation not found in the map falls back to being
used as-is (so an unrecognized code degrades gracefully rather than breaking
the run) — check the schedule's legend table for the actual code and add it
to the map if that happens.

## Combined-link rows (two sessions, one recording)

Sometimes a single Zoom link covers two back-to-back sessions recorded as
separate clips within one meeting occurrence — visible in Zoom's own player
as a "Recording 1"/"Recording 2" switch that appears once the first clip
finishes. The sheet marks this by slash-joining multiple course codes (and
faculty) in one row, e.g.:

```
Course Code with Session No.: DSM 101 (1)/ ME (2)
Faculty:                      Prof. Suman Majumdar/Prof. Karthikeya Naraparaju
Recording Link:               <one shared link>
```

The script detects this automatically (splitting on `/`), resolves each
half's subject code (see above), fetches each clip from Zoom as its own
file, and saves/uploads/tracks them completely independently — `DSM-101 (1)`
lands in the `DSM-101/` folder and `ME (2)` lands in `DSM-107/`, on Drive too,
exactly as if they'd had separate links (and exactly as if `DSM-107/` had
been reached via a normal single-session row, since it's the same subject).
No config needed beyond `subjectCodeMap`; this just works whenever a row's
course-code column contains a `/`.

Under the hood: Zoom's player only reveals a clip's real video URL once it's
been played to the end (a client-side navigation to a new signed URL, which
is also what powers that "forward" button in the UI) — the script drives
this by seeking each clip to just before its end and letting it play out,
rather than needing to find and click that control directly.

## Saving local disk space

Once a recording is confirmed uploaded to Drive, the local copy is
redundant. Set `driveUpload.deleteLocalAfterUpload: true` and the script
deletes the local file (and its now-empty session folder) right after a
successful upload — never before the upload is confirmed and recorded in
`stateFile`, so a failed or interrupted upload always leaves the local file
in place for a retry.

This doesn't lose tracking: a row with `upload.status: "uploaded"` in
`stateFile` is treated as fully done even with no local file present (see
"How 'already done' is tracked" below) — the log *is* the record of what was
uploaded, exactly as intended. `webViewLink` in that record is a direct link
back to the file on Drive if you ever need to re-fetch a copy.

## One-time setup

```bash
cd scripts/zoom-recordings
npm install
```

**Google OAuth client** (for reading the sheet and uploading to Drive as
yourself — no sheet-owner cooperation needed):
1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   enable the [Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)
   and the [Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   on whichever project you're using.
2. Create an OAuth Client ID of type **Desktop app** (not Web application —
   Desktop app needs no redirect URI setup at all).
3. Download the resulting `client_secret_*.json` and save it as
   `oauth-client.json` in this folder (path is configurable via
   `googleOAuth.clientSecretFile`).

This file identifies the *app*, not your identity — you still grant it
access to your own account interactively on first run. Don't commit it
anywhere public regardless.

**Token expiry risk:** an OAuth client you create like this defaults to
Google's "Testing" publishing status (not verified/published). Google can
expire refresh tokens for testing-status apps — most commonly after ~7 days
of the app going unused, or if you don't periodically re-consent. If that
happens, cached auth stops working until you run the script once
interactively again to re-consent (`googleOAuth.tokenFile` gets deleted or
just fails to authenticate — either way, running `node download-recordings.mjs`
by hand will prompt for a fresh login). This mainly matters for the
unattended daily automation below, since it can't complete an interactive
consent flow by itself — its failure-path notification is what's meant to
tell you this happened, rather than the job just going quiet.

The script requests the broad `drive` scope (not the narrower `drive.file`),
because it needs to create files inside a Drive folder *you* picked, not one
the app created itself — `drive.file` only grants access to files/folders
the app creates, so it can't write into a pre-existing folder without a
Picker-based consent flow. Broad access is reasonable here since this is
your own unpublished OAuth client acting on your own account, but worth
knowing.

## Running it

```bash
npm run sync
```

- **First run only:** a browser tab opens asking you to log into Google and
  approve Sheets + Drive access. After that, the login is cached in
  `googleOAuth.tokenFile` and reused automatically — no browser needed for
  the sheet-reading or Drive-upload steps on later runs.
- It reads the recordings sheet this way, skips anything already downloaded
  *and* uploaded (tracked in `stateFile`), and — only if there's a real Zoom
  download pending — launches a separate, dedicated Chrome profile for that
  step, headlessly (no visible window, works fine with the lid closed) and
  using your actual installed Google Chrome app (`channel: "chrome"`), not
  Puppeteer's bundled "Chrome for Testing" binary — verified both the
  login-state check and the play-and-capture-signed-URL flow work
  identically headless, and that this doesn't require quitting your everyday
  Chrome (it's a completely separate profile directory). Using the real
  Chrome binary also stops macOS from repeatedly prompting for "Allow
  access" permissions (filesystem, sometimes Music) — those prompts were
  happening because the bundled binary's identity changes whenever
  Puppeteer/its Chrome build updates, so macOS kept treating it as a new,
  unrecognized app.
- **First Zoom login only:** run `node download-recordings.mjs --headed`
  once — headless has no visible window for you to log into, so if that page
  lands on a Google or Zoom sign-in screen, it fails immediately with a
  clear message telling you to re-run with `--headed`. With `--headed`, log
  in in the visible Chrome window, then go back to the terminal and press
  Enter. That session is saved in `chromeProfileDir` and reused headlessly
  after that (until it eventually expires, at which point re-run with
  `--headed` again).
- Rows that are already downloaded locally but not yet uploaded (e.g. Drive
  upload was added after you'd already downloaded some recordings, or a
  previous upload failed) get uploaded directly — no browser launch needed
  for those either.
- Safe to re-run any time (e.g. after each class) — already-done rows are
  skipped, and a run with nothing new never opens a browser at all.

**Using your real Chrome profile instead (no separate login at all):** set
`"chrome": { "useSystemProfile": true }`. This requires fully quitting Chrome
(Cmd+Q) before each run — Chrome only lets one process touch a profile at a
time — and it works around a Chrome security restriction (it refuses remote
debugging on its literal default profile directory) by copying your profile
into a scratch snapshot dir before each launch. In practice this hits a
macOS Keychain permission prompt the first time a new process reads your
cookies, which can't be scripted through non-interactively — so unless
you're prepared to click through that once per environment, the dedicated
profile above is the more reliable default.

Useful flags:

```bash
node download-recordings.mjs --dry-run       # list what would be downloaded, no browser download
node download-recordings.mjs --limit 1       # only process the first pending row (handy for testing)
```

## Unattended daily automation

The whole point of the OAuth + dedicated Chrome profile setup above is that,
once done once, the script needs no human present. `scripts/zoom-recordings/daily-check.sh`
wraps it with a deterministic report step, and a macOS `launchd` LaunchAgent
triggers it once a day with nobody watching:

```
launchd (9:00 AM daily)
  -> ~/.zoom-recordings-sync/daily-check.sh
       -> caffeinate -i node download-recordings.mjs > last-sync-output.log
            (runs synchronously in plain bash -- no tool-call timeout to
             outrun, see "Why the sync runs in bash, not an AI tool call"
             below)
       -> node send-report.mjs <exit-code> last-sync-output.log
            -> parses the log's SUMMARY line / FAIL lines, classifies the
               outcome against a small known set of non-transient error
               strings, emails a report via Gmail API, and prints RETRY
               or NO-RETRY (see "Reporting" below)
       -> on failure + a RETRY verdict, writes today's date to
          ~/.zoom-recordings-sync/retry-pending

launchd (every 15 min, catches up on wake if it missed a tick asleep)
  -> ~/.zoom-recordings-sync/retry-if-needed.sh
       -> no-op if retry-pending is absent or stale (near-zero cost)
       -> otherwise: consumes the flag, runs daily-check.sh --retry once
```

**This used to route through `claude -p` for both the diagnosis and the
notification (iMessage via `osascript`).** Both are gone. The Claude call's
only real job — read the finished log and decide if it looks OK, and
whether a same-day retry is worth queuing — turned out to be plain
pattern-matching against a small, closed set of error strings
`download-recordings.mjs` itself throws, never something that actually
needed LLM judgment. `send-report.mjs` does that matching directly now (see
its `NON_TRANSIENT_PATTERNS` list), at zero token cost/latency and with no
dependency on a `claude` install being present on whatever machine runs
this. iMessage is gone too: it never actually alerts for a message sent to
yourself (Apple suppresses the notification banner for that), so it was
already just "check the log/Messages thread if you want to be sure" —
email has no such suppression and shows up as a normal push notification.

**Why the sync runs in bash, not an AI tool call (kept for the history —
still true, just no longer relevant to notification):** two earlier
versions had Claude invoke `download-recordings.mjs` itself via the Bash
tool (first with the 60s default timeout, then the 600s max). Both broke
the same way once a run had enough new recordings to legitimately take
longer than that: the tool call gets backgrounded, and Haiku declared
itself "waiting for completion" / "monitor streaming" as its **final**
reply instead of actually blocking on the result — which ends the `-p`
session and kills the still-running sync mid-upload. Confirmed on
2026-08-25: two downloads failed outright and a third finished downloading
to disk but was killed before it could upload or even get written to the
state file. This isn't a prompt-wording problem, it's a hard tool-timeout
mechanic, so the sync runs as a plain synchronous bash command with no
timeout and no backgrounding possible, full stop — independent of whatever
reads its log afterward.

**Setup:**

1. Deploy the wrapper scripts outside `~/Documents` — required (see gotcha
   below), and re-run this any time you edit `scripts/zoom-recordings/daily-check.sh`
   or `scripts/zoom-recordings/retry-if-needed.sh`:
   ```bash
   cp scripts/zoom-recordings/daily-check.sh ~/.zoom-recordings-sync/daily-check.sh
   cp scripts/zoom-recordings/retry-if-needed.sh ~/.zoom-recordings-sync/retry-if-needed.sh
   chmod +x ~/.zoom-recordings-sync/daily-check.sh ~/.zoom-recordings-sync/retry-if-needed.sh
   ```
2. Install both LaunchAgents — the daily job
   (`~/Library/LaunchAgents/com.n0tv1cky.zoom-recordings-sync.plist`, edit the
   `Hour`/`Minute` in its `StartCalendarInterval` if you want a different time
   than 9:00 AM) and the retry-checker
   (`~/Library/LaunchAgents/com.n0tv1cky.zoom-recordings-retry.plist`):
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.n0tv1cky.zoom-recordings-sync.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.n0tv1cky.zoom-recordings-retry.plist
   ```

**Day-to-day commands:**

```bash
# Check what happened on recent runs (this is where the AI's own summary lands)
tail -f ~/.zoom-recordings-sync/daily-check.log

# Trigger a run right now, without waiting for 9am (useful for testing)
launchctl kickstart gui/$(id -u)/com.n0tv1cky.zoom-recordings-sync

# Check whether it's currently registered/running and see its config
launchctl print gui/$(id -u)/com.n0tv1cky.zoom-recordings-sync

# Stop it entirely (unregisters the scheduled job; doesn't delete any files)
launchctl bootout gui/$(id -u)/com.n0tv1cky.zoom-recordings-sync

# Fully uninstall (stop it, then remove the plist so it can't be re-bootstrapped by accident)
launchctl bootout gui/$(id -u)/com.n0tv1cky.zoom-recordings-sync
rm ~/Library/LaunchAgents/com.n0tv1cky.zoom-recordings-sync.plist

# Reinstall after editing the plist itself (e.g. changing the scheduled time)
launchctl bootout gui/$(id -u)/com.n0tv1cky.zoom-recordings-sync   # ok if this errors "could not find" -- means it wasn't loaded
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.n0tv1cky.zoom-recordings-sync.plist
```

**Reporting:** `send-report.mjs` reads `last-sync-output.log`, looks for the
`SUMMARY: downloaded=N uploaded=N fail=N skip=N` line `download-recordings.mjs`
prints at the end of a normal run (or, on a fatal crash with no such line, the
last ~25 lines of the log plus any `FAIL` lines), and emails one plain-text
report per run via the Gmail API to the address in `config.json`'s
`notifications.toEmail` — subject line front-loads the outcome (e.g. `Zoom
sync: 2 uploaded` or `Zoom sync FAILED (exit 1)`), so it's readable from a
lock-screen notification banner alone. This uses its own Gmail-send-only
OAuth token (`lib/gmailAuth.mjs`, `~/.zoom-recordings-sync/gmail-token.json`)
kept deliberately separate from the Sheets/Drive token above — see that
file's header comment for why (short version: adding a scope to an
*existing* cached grant without `prompt: consent` silently keeps the old,
narrower grant; a brand-new token file for a brand-new scope sidesteps that
entirely). See `docs/email-notifications.md` for the general Gmail-API-send
pattern this reuses.

**Same-day retry:** the scheduled 9am run wraps the sync in `caffeinate -i`
(blocks idle sleep only for that call, released automatically when it exits)
after a 2026-08-20 run got killed mid-request by idle sleep and silently
missed 2 real recordings — but that only covers idle sleep, not a manual
lid-close. If the sync still fails for any reason, `send-report.mjs` checks
the log against `NON_TRANSIENT_PATTERNS` — a short list of exact error
strings `download-recordings.mjs` itself throws for expired/invalid
credentials, a missing scope, a broken Chrome profile sync, or a missing
`oauth-client.json` — and prints `NO-RETRY` when one matches, `RETRY`
otherwise. `daily-check.sh` captures that one line and writes today's date to
`~/.zoom-recordings-sync/retry-pending` only on `RETRY`. This is deliberately
fail-open: anything that *doesn't* match a known non-transient signature
(a network blip, a timeout, a Drive/Zoom hiccup, Chrome closing unexpectedly,
or genuinely novel breakage this list doesn't cover yet) defaults to
*retrying* — an unneeded retry costs a few cents and 15 minutes, while
wrongly suppressing a real one costs a full missed day, so the asymmetry
favors retrying. If a new non-transient failure mode shows up in practice,
add its error string to `NON_TRANSIENT_PATTERNS` in `send-report.mjs` rather
than reaching for judgment-based classification again — every failure mode
seen so far has had a fixed, matchable message.

A second LaunchAgent (`com.n0tv1cky.zoom-recordings-retry.plist`) polls every
15 minutes for the retry flag — there's no clean launchd "on wake" event, but
a `StartInterval` job that was due while asleep fires once to catch up right
after wake, the same mechanism `StartCalendarInterval` uses, so this
effectively retries "next time the Mac wakes" as well as periodically while
it's already awake. Almost every one of those 15-minute firings is a no-op
(flag absent, near-zero cost); when the flag is set for *today* specifically,
it consumes the flag and runs `daily-check.sh --retry` once. A `--retry` run
does not re-arm the flag on failure (regardless of tag), so this is at most
one extra attempt per day — a second same-day failure is left for tomorrow's
normal scheduled run (safe because the state file makes re-runs idempotent
per recording). A flag left over from a previous day (e.g. the Mac stayed
asleep for days) is discarded without running anything.

**Optional: waking the Mac for a closed lid.** By default, if the lid is
closed at 9am, `launchd` doesn't queue the missed run — it just fires once,
whenever the Mac next actually wakes (see `docs/background-automation.md`
for why: closing the lid is full system sleep, not a pause). That's already
safe here (same-day retry + idempotent re-runs mean nothing is lost, just
possibly delayed), but if you want the sync to actually run closer to 9am
regardless of lid state, `schedule-wakeup.sh` + `install-wake-scheduler.sh`
queue a macOS scheduled-wake event (`pmset schedule wake`) for
`config.json`'s `dailyRunTime` every night at 00:05, mirroring
`scripts/calendar-sync`'s own wake scheduler:

```bash
sudo ./install-wake-scheduler.sh
```

This is a genuinely optional add-on, not installed by default — read
`schedule-wakeup.sh`'s header before installing it. The short version: it
needs a root LaunchDaemon (`pmset schedule` requires root, hence a
`LaunchDaemon` in `/Library/LaunchDaemons/`, not another per-user
`LaunchAgent`), it queues one-time events re-armed nightly (`pmset` has no
"repeat daily at this time" primitive), and — the real limit worth knowing
before relying on it — Apple's scheduled wake is only reliably honored while
plugged into AC power; on battery alone it's inconsistent across Mac
models, with no way to verify that from software. If it doesn't wake this
particular Mac reliably, that's a platform limit, not a bug to chase —
uninstall it and rely on the existing catch-up-on-next-wake behavior
instead (see its header comment for the exact `launchctl bootout` command).

**Known gotcha (already solved, documented for future edits):** macOS TCC
blocks background (non-GUI, launchd-spawned) processes from *executing* a
script that lives inside `~/Documents` — you'll see `Operation not
permitted` in the log, even though the very same script runs fine from an
interactive terminal, and even though `node` itself can freely *read* files
under `~/Documents` from the same context. There's no way to grant this
non-interactively (it needs a GUI permission dialog with nobody there to
click it). The fix is structural, not a permission grant: keep the actual
executed entrypoint (`daily-check.sh`) outside `~/Documents` entirely —
which is why the deployed copy lives in `~/.zoom-recordings-sync/` while the
git-tracked source stays in the repo for review/history.

**On the OAuth token expiring:** see the note under Google OAuth setup above
— if it happens, this wrapper's failure-path notification is exactly the
mechanism that should tell you, rather than the job just going quiet.

## Using it next term

Everything term-specific lives in `config.json` — no code changes needed:

```jsonc
{
  "term": "MSDSM Batch 7 - Term 1",           // just a label, shown in logs
  "recordingsSheet": {
    "id": "<new sheet id from the URL>",       // .../spreadsheets/d/<id>/edit...
    "gid": "<new tab id>"                      // .../edit?gid=<gid>
  },
  "columns": {                                 // update if the header text changes
    "date": "Date",
    "time": "Time",
    "courseCode": "Course Code with Session No.",
    "faculty": "Faculty",
    "linkActiveFrom": "Link active from date",
    "linkActiveTo": "To Date",
    "link": "Recording Link"
  },
  "outputDir": "../../docs/recordings/videos/MSDSM_Batch7_Term1",  // relative to this config file
  "organizeByCourse": true,
  "stateFile": "~/.zoom-recordings-sync/msdsm-batch7-term1-state.json",
  "chrome": {
    "useSystemProfile": false
  },
  "driveUpload": {
    "enabled": true,
    "rootFolderId": "<YOUR_DRIVE_ROOT_FOLDER_ID>",  // same Drive folder every term is fine
    "organizeByCourse": true,
    "deleteLocalAfterUpload": true  // free local disk space once Drive has a confirmed copy
    // termFolderName defaults to outputDir's folder name (e.g.
    // "MSDSM_Batch7_Term1") -- update outputDir above and this follows
    // automatically; only set termFolderName explicitly to override that.
  },
  "fileNameTemplate": "{courseCode}_{date}_{faculty}.mp4",
  "subjectCodeMap": {                          // sheet abbreviation -> canonical "DSM <N>" code, from that term's schedule sheet legend table
    "ME": "DSM 107",
    "MC": "DSM 104"
    // ...one entry per subject taught that term
  }
}
```

Keep a separate `config.json` (or copy this folder) per term/course if you
want independent output folders and download-history tracking — pass a
different file with `--config path/to/other-config.json`.

The sheet ID and tab id (`gid`) come straight out of the sheet's URL:
`https://docs.google.com/spreadsheets/d/<id>/edit?gid=<gid>`.

The cached Google OAuth login (`googleOAuth.tokenFile`) isn't term-specific —
as long as you can already view the new term's sheet with your own account,
no new consent step is needed.

## How it works

1. Reads the recordings sheet via the real Sheets API (`spreadsheets.values.get`,
   `UNFORMATTED_VALUE` so date cells come back as serial numbers rather than a
   locale-formatted string that's ambiguous to reparse) — no browser involved.
2. For each row with a link not already downloaded, opens the Zoom share
   link and clicks its Play button (Zoom only wires up the real signed video
   URL in response to an actual click, not a scripted `video.play()`), then
   polls the `<video>` element's `currentSrc` until Zoom's player assigns it.
3. The actual ~150MB+ byte transfer happens in Node, not the browser: it
   replays the same session (cookies + Referer + User-Agent lifted from the
   live page) as an authenticated request and streams the response straight
   to disk. (Fetching that much data *inside* the page and buffering it
   there — the obvious approach — reliably fails partway through on
   Puppeteer's bundled Chrome; doing the transfer in Node sidesteps that
   entirely and is more memory-efficient besides.)
4. If `driveUpload.enabled`, uploads the saved file to Drive via the Sheets
   API's sibling Drive API, mirroring the local layout: `rootFolderId` gets a
   `termFolderName` subfolder (one per term, so the same root folder can be
   reused across terms indefinitely), and inside that, one subfolder per
   session (`organizeByCourse: true`). This step runs independently of the
   download step (see below), so
   it also picks up files that were downloaded before Drive upload existed
   or that failed to upload on a previous run.
5. Records download and upload success/failure per link in `stateFile`
   separately, so re-runs are cheap and never redo work that already
   succeeded.

## How "already done" is tracked

`stateFile` is a JSON object keyed by the **Zoom recording link itself**
(the sheet's "Recording Link" column) — not row position, not filename. Each
session has its own distinct share link, so it's a reliable per-recording
identifier that survives the sheet being re-sorted or having rows
inserted/removed above it. For a combined-link row (see above), each split
session gets its own key instead — the link with `#clip0`, `#clip1`, etc.
appended — since multiple sessions share one link there. Download and upload
are tracked as separate sub-objects, since one can succeed while the other
fails or hasn't happened yet. Example entry:

```json
{
  "https://zoom.us/rec/share/w48cxzoxELTV...": {
    "download": {
      "status": "downloaded",
      "file": "/Users/.../ME-1/ME-1_2026-08-14_Karthikeya-Naraparaju.mp4",
      "at": "2026-08-16T22:11:03.000Z"
    },
    "upload": {
      "status": "uploaded",
      "fileId": "<file-id>",
      "webViewLink": "https://drive.google.com/file/d/<file-id>/view?usp=drivesdk",
      "at": "2026-08-16T22:52:40.000Z"
    }
  }
}
```

A row needs re-downloading from Zoom only when **both**:
1. no local file exists at its expected path, **and**
2. it isn't already `upload.status: "uploaded"` (with Drive upload enabled).

That second condition is what makes `deleteLocalAfterUpload` safe: once a
row is uploaded, a missing local file is treated as "no longer needed," not
"lost" — the Drive copy is trusted as the durable one. Without Drive upload
enabled, a missing local file always means "needs downloading" — there'd be
no other copy to fall back on.

Separately, a row needs uploading only when Drive upload is enabled and
`upload.status` isn't `"uploaded"` yet. A failed upload doesn't touch or
invalidate the download record — only the `upload` sub-object gets marked
`"failed"`, so a retry re-uploads the already-downloaded file rather than
re-fetching it from Zoom (as long as `deleteLocalAfterUpload` hasn't removed
it — deletion only ever happens right after a *successful, recorded* upload,
never after a failed one).

If you delete a video file by hand *without* it being uploaded first, the
next run notices it's genuinely missing and re-downloads it, even if some
other part of the state file is stale.

Drive folder lookups (both the term folder and, if `organizeByCourse`, the
per-session subfolders) re-query Drive by name each run rather than trusting
a local cache across runs, so re-running the script never creates duplicate
folders even if state was lost or edited by hand.

**Known gap:** if a row's course code, date, or faculty value changes later
(anything that feeds `fileNameTemplate`) while its link stays the same, the
old file won't match the newly-computed filename, so the script re-downloads
(and re-uploads) under the new name rather than renaming the existing
file/Drive object. The link-based key prevents duplicate fetches of an
unchanged row; it doesn't rename files after the fact.

## Notes

- This relies on recordings being viewable via the share link (no Zoom
  passcode you'd need to enter, and download access authorized by your
  instructor/institute). If a link is passcode-protected, add passcode
  handling before use.
- Videos with a very long runtime take a while — the script waits up to 15
  minutes per file for the download to finish before giving up.
