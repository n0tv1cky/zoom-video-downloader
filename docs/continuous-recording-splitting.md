# Splitting a continuous recording into its two sessions (plan)

**Status: planned, not yet implemented.** Written down before building so the
design is settled first — this is the spec `download-recordings.mjs` /
`send-report.mjs` should be built against, not yet what the code does.

## The problem

`scripts/zoom-recordings` already handles one combined-recording shape: a
row like `DSM 101 (5)/DSM 102 (2)` sharing a single Zoom share link because
the presenter stopped and restarted the recording between the two classes,
producing two separate clips inside Zoom's own multi-clip player.
`expandRowIntoSessions` + `grabClipUrls` handle exactly that (see
`docs/course-codes.md` and `README.md` for the existing mechanism).

**This plan covers the other shape**: nobody stopped the recording at all,
so Zoom produced one continuous clip covering both sessions back-to-back
(confirmed live on 2026-08-27: `DSM 101 (5)/DSM 102 (2)`, a single
~2h15m recording, `grabClipUrls` correctly found only 1 clip where 2 were
expected — that's not a bug, it's the real shape of the recording).
Currently this just fails the second (and any further) session with
`expected clip N of M, but Zoom only reported 1` and retries forever
(nothing about the situation changes on retry) — this plan replaces that
dead-end with an actual split.

## Detection

In the per-link download loop, when `grabClipUrls` returns fewer clips than
`group[0].session.expectedClips` **and returns exactly 1 clip** (a genuine
single continuous recording, not some partial multi-clip glitch worth
still treating as a real failure), treat the whole group as one
"continuous recording covering N sessions" case instead of failing sessions
2..N individually.

## Finding the cut point: schedule narrows the window, silence detection finds the exact cut

Two ideas, and neither is sufficient alone:

- **Proportional guess from the schedule alone** (`cut = duration ×
  session1Slot ÷ totalSlots`) is a reasonable ballpark but assumes the
  recording started exactly on the official slot boundary and that both
  sessions ran exactly their nominal length — neither is reliable in
  practice (professors run a few minutes over/under, Zoom recordings start
  a little early/late).
- **Blind audio-silence detection over the whole file** would find real
  gaps, but a lecture has its own internal pauses (a professor pausing,
  students unmuting then going quiet) that would produce false positives
  far from the actual session boundary.

**Combined approach:**

1. Compute an *expected* boundary from a `timeSlots` schedule (see Config
   below) — this only defines a **search window** (e.g. ±10 minutes around
   the expected boundary), not the cut itself.
2. Run `ffmpeg -i <file> -af silencedetect=noise=-35dB:d=1 -f null -` once
   over the whole file (single decode pass) and parse `silence_start`/
   `silence_end` timestamps out of stderr.
3. Filter to silence intervals that fall inside the search window.
4. If one or more candidates exist, pick the **longest** silence interval
   in the window — real inter-class gaps (screens/mics resetting, a
   professor leaving, the next one starting cold) are typically longer than
   an in-lecture pause. Cut at, e.g., the interval's midpoint.
5. **If no silence interval falls inside the window at all** (no clean gap
   — overlapping handoff, background/hold music, a muted-but-not-silent
   room), there is no confident automatic answer. This is the *only* case
   that needs a human: fall back to proposing the plain proportional
   midpoint, mark the state entry so it's clearly visible as
   "needs a manual timestamp," and require running `confirm-split.mjs
   --at MM:SS` once with a real timestamp (found by scrubbing the file)
   before anything is cut or uploaded.

Everything else — a silence candidate was found in the window — proceeds
**fully automatically**: split, upload, mark both sessions `uploaded`, no
human step. This was an explicit design choice: requiring confirmation on
every occurrence was considered and rejected as unnecessary overhead for
the common case, where a real inter-class silence gap is almost always
findable; a human is only actually useful for the genuinely ambiguous case
where the algorithm has nothing better than a guess.

## Splitting the file

Once a cut point (in seconds) is chosen, split with a stream copy — no
re-encode, fast, lossless:

```bash
ffmpeg -i raw.mp4 -to <cut> -c copy session1.mp4
ffmpeg -i raw.mp4 -ss <cut> -c copy session2.mp4
```

(`-c copy` re-muxes at the nearest keyframe rather than re-encoding frame
data — worth confirming in practice whether that lands close enough to the
chosen cut for this use case, or whether a precise re-encode is needed for
the boundary GOP only.)

## State: a new `pending-manual-split` status, not `failed`

Marking the ambiguous case as `failed` would feed it into the existing
same-day-retry mechanism (`send-report.mjs`'s `NON_TRANSIENT_PATTERNS` /
`RETRY` verdict) pointlessly — retrying doesn't change anything about an
inherently ambiguous audio track. Instead:

- **Automatic split succeeds**: both sessions' state entries go straight to
  `download`/`upload` `"status": "uploaded"`, same as any normal session —
  no new state shape needed for the common case.
- **No confident silence candidate found**: both sessions' state entries get
  `{ "status": "pending-manual-split", "rawFile": "<path>", "proposedCutSeconds": N, "searchWindow": [start, end] }`.
  This is a terminal state until a human runs `confirm-split.mjs` — it must
  NOT be retried automatically (the situation won't change on its own), and
  must NOT be silently skipped as if already handled.

## Report integration

`send-report.mjs` should treat `pending-manual-split` entries as their own
category in the email, distinct from both success and `FAIL` — e.g. "1
recording needs a manual split — run `confirm-split.mjs <stateKey>`,
proposed cut ~62:30" — so it reads as an actionable one-time task, not a
transient failure that'll silently keep retrying and failing.

## `confirm-split.mjs` (only needed for the ambiguous case)

```
node confirm-split.mjs <stateKey> --at 62:30
```

- Takes the real timestamp (found by scrubbing the raw file locally —
  QuickTime or similar), splits, uploads both resulting files, updates both
  sessions' state entries to `uploaded`, and only then deletes the raw
  combined file (mirroring the existing `deleteLocalAfterUpload` care
  elsewhere in this pipeline — never delete before both uploads are
  confirmed).
- Should refuse to run without `--at` for a `pending-manual-split` entry
  (no silent default here — this is exactly the case where a guess wasn't
  good enough).

## Config: `timeSlots`

Add a `timeSlots` block to `scripts/zoom-recordings/config.json`, matching
the shape already used by `scripts/calendar-sync` and `scripts/attendance`
(duplicated deliberately, not shared — see `docs/course-codes.md`'s
"hand-duplicated... update the others too" note, which already documents
this exact tradeoff for `subjectCodeMap` and applies the same way here):

```json
"timeSlots": {
  "weekday": [
    { "label": "Session-I", "start": "19:00", "end": "20:00" },
    { "label": "Session-II", "start": "20:15", "end": "21:15" }
  ],
  "weekend": [
    { "label": "Session-I", "start": "10:45", "end": "11:45" },
    { "label": "Session-II", "start": "12:00", "end": "13:00" },
    { "label": "Session-III", "start": "14:45", "end": "15:45" },
    { "label": "Session-IV", "start": "16:00", "end": "17:00" }
  ]
}
```

This is used only to pick a search window for silence detection, never as
the cut point directly — see "Finding the cut point" above.

## Open implementation notes (to resolve while building, not blocking the plan)

- Exact `silencedetect` thresholds (`-35dB`, `d=1`) are a starting guess —
  worth tuning against a real example or two once this is built, since
  Zoom's own noise floor/background hum could push a sensible threshold
  either direction.
- Whether to cut at a silence interval's midpoint, start, or end needs
  eyeballing against a real split — whichever avoids clipping either
  session's actual speech.
- `-c copy`'s keyframe-boundary snapping might need a precise fallback (a
  short re-encode of just the boundary segment) if it turns out to land
  noticeably off from the chosen timestamp in practice.
