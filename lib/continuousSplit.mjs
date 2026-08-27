// Splits a single continuous Zoom recording (nobody stopped/restarted
// between two back-to-back classes, so Zoom produced one clip instead of
// two) into its per-session files. See
// docs/continuous-recording-splitting.md (in the sibling docs monorepo) for
// the full design this implements: a schedule-derived search window narrows
// where to look, ffmpeg's own silencedetect filter finds the real gap
// inside that window, and only when no clean gap exists there does this
// fall back to an unconfident guess that the caller must treat as needing a
// human timestamp (see pickCutPoints' `confident` field).
//
// All ffmpeg/ffprobe calls are synchronous (spawnSync) -- these are quick,
// single-file, one-shot operations in an already-sequential pipeline, not
// worth the complexity of streaming/async here.

import { spawnSync } from "node:child_process";

export function probeDurationSeconds(filePath) {
  const res = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath]);
  if (res.status !== 0) throw new Error(`ffprobe failed to read duration of ${filePath}: ${res.stderr}`);
  const seconds = parseFloat(res.stdout.toString().trim());
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe returned a non-numeric duration for ${filePath}: ${res.stdout}`);
  return seconds;
}

// Runs ffmpeg's silencedetect audio filter over the whole file in one decode
// pass (no output file -- -f null -) and parses `silence_start`/
// `silence_end`/`silence_duration` out of stderr, which is where ffmpeg
// filter logging always goes regardless of -loglevel for the primary
// stream. noiseDb/minDurationSec are exposed for tuning against a real
// example (see the plan doc's "Open implementation notes") -- -35dB/1s are
// starting guesses, not verified against Zoom's actual noise floor yet.
export function detectSilenceGaps(filePath, { noiseDb = -35, minDurationSec = 1 } = {}) {
  const res = spawnSync("ffmpeg", ["-i", filePath, "-af", `silencedetect=noise=${noiseDb}dB:d=${minDurationSec}`, "-f", "null", "-"]);
  const stderr = res.stderr.toString();

  const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)].map((m) => ({
    end: parseFloat(m[1]),
    duration: parseFloat(m[2]),
  }));

  // silencedetect emits _start and _end/_duration as separate log lines but
  // always in matching order for a single-pass scan, so pairing by index is
  // safe here (a trailing unmatched _start with no _end, if the file ends
  // mid-silence, is simply dropped -- not a useful split candidate anyway).
  const gaps = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    gaps.push({ start: starts[i], end: ends[i].end, duration: ends[i].duration });
  }
  return gaps;
}

// sessionDurationsMin: official/expected duration (minutes) of each session
// in this group, in order -- used only to weight where each boundary is
// *expected* to fall (as a fraction of total duration), never as the cut
// itself. windowMin: how far either side of that expected boundary to
// search for an actual silence gap.
//
// Returns one entry per boundary (sessionDurationsMin.length - 1 entries):
// { cutSeconds, confident, expectedSeconds, windowStart, windowEnd }.
// confident: false means no silence gap was found inside the window, so
// cutSeconds is just the unconfirmed expected-boundary fallback -- the
// caller must NOT act on this automatically (see
// docs/continuous-recording-splitting.md's pending-manual-split state).
export function pickCutPoints({ durationSec, sessionDurationsMin, silenceGaps, windowMin = 10 }) {
  const totalMin = sessionDurationsMin.reduce((a, b) => a + b, 0);
  const windowSec = windowMin * 60;

  let cumulativeMin = 0;
  const boundaries = [];
  for (let i = 0; i < sessionDurationsMin.length - 1; i++) {
    cumulativeMin += sessionDurationsMin[i];
    const expectedSeconds = durationSec * (cumulativeMin / totalMin);
    const windowStart = Math.max(0, expectedSeconds - windowSec);
    const windowEnd = Math.min(durationSec, expectedSeconds + windowSec);

    const candidates = silenceGaps.filter((g) => g.start >= windowStart && g.end <= windowEnd);
    if (candidates.length === 0) {
      boundaries.push({ cutSeconds: expectedSeconds, confident: false, expectedSeconds, windowStart, windowEnd });
      continue;
    }

    // Longest silence in the window is the best guess for a real inter-class
    // gap (screens/mics resetting, one presenter leaving before the next
    // starts) as opposed to a short in-lecture pause -- see the plan doc.
    const longest = candidates.reduce((a, b) => (b.duration > a.duration ? b : a));
    const cutSeconds = longest.start + longest.duration / 2;
    boundaries.push({ cutSeconds, confident: true, expectedSeconds, windowStart, windowEnd, matchedGap: longest });
  }
  return boundaries;
}

// Splits rawPath into cutPointsSeconds.length + 1 files via stream copy (no
// re-encode -- fast, lossless, but snaps to the nearest keyframe at or
// before each requested timestamp; see the plan doc's open note about
// whether that's precise enough in practice). -ss/-to as *input* options
// (before -i) rather than output options: both are then absolute positions
// within the input and combine correctly with -c copy, unlike putting -to
// after -i (which ffmpeg would instead interpret relative to -ss).
export function splitByCutPoints(rawPath, cutPointsSeconds, outPaths) {
  if (outPaths.length !== cutPointsSeconds.length + 1) {
    throw new Error(`splitByCutPoints: expected ${cutPointsSeconds.length + 1} output paths for ${cutPointsSeconds.length} cut point(s), got ${outPaths.length}`);
  }

  const bounds = [0, ...cutPointsSeconds, undefined];
  for (let i = 0; i < outPaths.length; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    const args = ["-y"];
    if (start > 0) args.push("-ss", String(start));
    if (end !== undefined) args.push("-to", String(end));
    args.push("-i", rawPath, "-c", "copy", outPaths[i]);

    const res = spawnSync("ffmpeg", args);
    if (res.status !== 0) {
      throw new Error(`ffmpeg failed splitting ${rawPath} (segment ${i}, ${start}-${end ?? "end"}): ${res.stderr.toString().slice(-2000)}`);
    }
  }
}
