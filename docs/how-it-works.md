# How it works

The detail behind the [README](../README.md). For setup, see [SETUP.md](SETUP.md).

## The pipeline

1. **Read the sheet.** The recordings sheet is read through the Google Sheets
   API (`spreadsheets.values.get`, `UNFORMATTED_VALUE`, so dates come back as
   serial numbers instead of locale-formatted strings). No browser is involved.
2. **Find the video.** For each row that isn't done yet, a headless Chrome
   (your installed Google Chrome, with its own dedicated profile) opens the
   Zoom share link and presses Play. Zoom only assigns the signed video URL
   after a real click. The script then reads it from the `<video>` element.
3. **Download in Node.** The transfer runs in Node, not in the page. It replays
   the page's cookies, Referer and User-Agent and streams to a `.partial` file,
   which is renamed only once the transfer finishes. So an interrupted
   download never looks finished.
4. **Upload (optional).** If `driveUpload.enabled` is on, the file goes to
   `rootFolderId / termFolderName / <course>/` on Drive. Upload is tracked
   separately from download, so a failed upload is retried without
   re-downloading.
5. **Record it.** Status is saved in `stateFile`, so re-runs only do pending
   work.

Zoom's share page has no Download button on this plan. The script doesn't
need one, because it captures the same stream the player plays.

## Course codes and file names

The sheet uses short abbreviations (`ME (2)`, `MP (7)`). `subjectCodeMap` in
`config.json` maps them to canonical codes (`ME` → `DSM 107`), and folders and
file names use the canonical form:

```
DSM-107/DSM-107-2_2026-08-17_Karthikeya-Naraparaju.mp4
```

Some quirks the parser copes with:
- `DSM 101(18)`, lowercase `dsm 103`, `ME 11 (DS)`.
- Merged date cells. A blank date is forward-filled from the row above.
- Faculty titles: `Prof.` and `Dr.` are dropped and names are capitalised.

A code that still doesn't resolve is downloaded, because links expire, but it
is held back from upload and reported on every run.

**Session numbers are derived, not copied from the sheet.** Session N is the
Nth class of that course actually held, in date and time order. The sheet's
own labels repeat, skip and go missing. Classes that were held but have no
recording go in `heldWithoutRecording`, so later numbers stay right. When the
sheet's label disagrees, a warning is printed once.

## Rows with more than one class

**Several recordings on one link.** A row like `DSM 101 (1)/ ME (2)`
(slash-joined codes and faculty) shares one Zoom link between back-to-back
classes. If the host stopped and restarted the recording, the share page
lists "Recording 1", "Recording 2" and so on. Each one is fetched separately
and filed under its own course, tracked as `<link>#clip0`, `#clip1`, and so on.

- **Files are matched by position.** If the share page has a different number
  of files than the row has classes (for example, a stray 9-second recording),
  the script refuses to guess and reports it.
- **Fixing order and count by hand.** Give each class a `clip` (1-based file
  number) in `sessionOverrides` and it will fetch exactly those. Use the same
  `clip` entry when the row lists the classes in a different order than Zoom
  recorded them.

**One continuous recording.** If nobody stopped the recording between
classes, Zoom produces a single long file. The script downloads it once and
finds the break between classes with `ffmpeg silencedetect`, searching only
around the expected time from `timeSlots`. It then splits the file and
uploads each part. If there's no clean gap, it parks the recording as
`pending-manual-split`; resolve that with:

```bash
node confirm-split.mjs <stateKey> --at 62:30
```

The full reasoning is in
[continuous-recording-splitting.md](continuous-recording-splitting.md).

## Hand corrections (`sessionOverrides`)

Fixes for sheet mistakes go in `config.json`, keyed
`"<YYYY-MM-DD> <row start time> <DSM code>"`:

```json
"2026-11-19 7:00pm DSM 101": { "faculty": "Ruchi Sharma", "clip": 2 }
```

- `faculty` replaces the sheet's faculty for that class.
- `clip` picks which recording file (or which half of a split recording)
  belongs to it.

Files already on Drive are renamed and moved to match the next time the sync
runs. It only renames and moves; it never deletes. Faculty is never
auto-corrected; a value that isn't in `courseFaculty` is only flagged.

## How "already done" is tracked

`stateFile` is a JSON object keyed by the Zoom link (plus `#clipN` for
multi-class rows), not by row position. So it survives the sheet being
re-sorted. Each entry has separate `download` and `upload` records:

```json
{
  "https://zoom.us/rec/share/<id>": {
    "download": { "status": "downloaded", "file": "/…/DSM-107-1_….mp4", "at": "…" },
    "upload":   { "status": "uploaded", "fileId": "<file-id>", "fileName": "…", "folder": "DSM-107", "at": "…" }
  }
}
```

- **When it re-downloads.** A recording is downloaded again only if there is
  no local file *and* it isn't marked uploaded. This is what makes
  `deleteLocalAfterUpload` safe: once Drive has a confirmed copy, a missing
  local file just means "no longer needed".
- **Drive folders.** Folders are looked up by name on every run, so lost
  state never creates duplicate folders.
- **The session ledger.** Each run also writes `sessionLedger.file`
  (`~/.zoom-recordings-sync/sessions.json`), the corrected course, date and
  session-number list. Other tools can look up file names there. It holds
  Drive IDs, so it stays outside the repo.

## Using it for a new term

Everything term-specific is in config, not code:
- `term`, `recordingsSheet` (in `config.local.json`), `columns` and `outputDir`
- `stateFile` (use a new file per term)
- `subjectCodeMap` and `courseFaculty`
- `sessionOverrides` and `heldWithoutRecording`: clear both

`driveUpload.termFolderName` defaults to the `outputDir` folder name. Keep one
config per term and pass it with `--config path/to/term2.json`. The Google
login is not tied to a term.

## Limits

- **No passcodes.** Recordings must play from the share link without one. A
  passcode-protected link would need extra handling.
- **Links expire.** Once a link's "active to" date passes, the page loads but
  the video doesn't, so run the sync at least every few days.
- **Download timeout.** Each download waits up to 15 minutes before giving up.
