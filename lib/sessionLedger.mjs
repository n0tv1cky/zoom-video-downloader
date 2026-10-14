// One session numbering across the three tools that care about it --
// this sync (Drive file names), the sibling attendance project ("Session N"
// columns in the shared attendance sheet) and msdsm-notes (lecture-notes
// file names). The rule all three follow: session N is the Nth class of
// that course actually held, in date/time order. The sheet's own labels
// don't reliably follow it (repeated numbers, a skipped 24, extra classes
// it never counted), so this sync corrects them via config.json's
// sessionOverrides/sessionOffsets, and attendance derives it independently
// by counting held classes in the timetable.
//
// writeSessionLedger publishes the corrected numbering every run, keyed by
// course + date + start time -- the stable identity of a class -- so other
// tools look names up instead of copying whatever a Drive file was called
// when they first saw it (how msdsm-notes ended up keeping pre-correction
// names). It holds Drive file IDs, so it lives in ~/.zoom-recordings-sync,
// never inside a repo.
//
// crossCheckAttendance compares the two independent derivations and flags
// disagreements once each, as WARN lines the report email already picks
// up. On 2026-10-14 they agreed on 67 classes; the exceptions were exactly
// the real problems: 10-12 (attendance 24, recording 25 -- the label skip),
// a 10-06 attendance run against a timetable slot that turned out to be a
// different course, and two DSM 108 classes attendance never marked.
import fs from "node:fs";
import path from "node:path";

const ATTENDANCE_ONLY_GRACE_DAYS = 3; // recordings reach the sheet ~1 day after class

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(`${file}.tmp`, file);
}

function sessionNumbers(plan) {
  return String(plan.session.sessionNumber ?? "").split("-").filter(Boolean);
}

export function writeSessionLedger(file, plan, state, { term, formatDate, startTime }) {
  const sessions = plan
    .filter((p) => p.session.codeResolved)
    .map((p) => {
      const upload = state[p.session.stateKey]?.upload;
      return {
        course: p.session.subjectCode,
        session: p.session.sessionNumber,
        date: formatDate(p.session.date),
        start: startTime(p.session),
        faculty: p.session.faculty,
        fileName: p.fileName,
        folder: p.courseFolderName,
        driveFileId: upload?.status === "uploaded" ? upload.fileId : null,
      };
    })
    .sort((a, b) => a.course.localeCompare(b.course) || a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  writeJsonAtomic(file, { term, generatedAt: new Date().toISOString(), rule: "session N = the Nth class of the course actually held, in date/time order", sessions });
}

function istDate(iso) {
  return new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
}

// Attendance's own run log (written by projects/attendance, read-only here).
// Only runs that actually marked someone count -- a dry run, a skip or a
// failed join says nothing about how the class was numbered.
function readAttendanceRuns(runsFile) {
  if (!fs.existsSync(runsFile)) return null;
  return fs
    .readFileSync(runsFile, "utf8")
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r?.apply && r.subjectCode && r.sessionNumber && (r.writtenCount ?? 0) + (r.alreadyMarkedCount ?? 0) > 0);
}

export function crossCheckAttendance({ plan, runsFile, warnedFile, since, now = new Date(), formatDate, dryRun }) {
  const runs = readAttendanceRuns(runsFile);
  if (!runs) return;

  const byKey = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };
  const attendance = new Map();
  for (const r of runs) byKey(attendance, `${r.subjectCode}|${istDate(r.at)}`, String(r.sessionNumber));
  const recordings = new Map();
  const planFor = new Map();
  for (const p of plan) {
    if (!p.session.codeResolved || !p.session.sessionNumber) continue;
    const key = `${p.session.subjectCode}|${formatDate(p.session.date)}`;
    for (const n of sessionNumbers(p)) byKey(recordings, key, n);
    if (!planFor.has(key)) planFor.set(key, p);
  }

  const warned = fs.existsSync(warnedFile) ? JSON.parse(fs.readFileSync(warnedFile, "utf8")) : {};
  let changed = false;
  const warnOnce = (id, kind, label, message) => {
    if (warned[id]) return;
    console.log(`WARN  (${kind}) ${label}: ${message}`);
    if (!dryRun) {
      warned[id] = new Date().toISOString();
      changed = true;
    }
  };
  const fmt = (set) => [...set].sort((a, b) => a - b).join(" & ");
  const today = formatDate(now);
  const daysAgo = (date) => (new Date(today) - new Date(date)) / 86_400_000;

  for (const key of new Set([...attendance.keys(), ...recordings.keys()])) {
    const [course, date] = key.split("|");
    if (since && date < since) continue;
    const a = attendance.get(key);
    const r = recordings.get(key);
    const label = planFor.get(key)?.fileName ?? `${course.replace(" ", "-")} ${date} (no recording)`;
    if (a && r && fmt(a) !== fmt(r)) {
      warnOnce(`${key}|mismatch|${fmt(a)}|${fmt(r)}`, "attendance numbered differently", label,
        `attendance marked ${course} on ${date} as session ${fmt(a)}, the recording is session ${fmt(r)}`);
    } else if (a && !r && daysAgo(date) >= ATTENDANCE_ONLY_GRACE_DAYS) {
      warnOnce(`${key}|attendance-only`, "attendance without recording", label,
        `attendance marked ${course} session ${fmt(a)} on ${date}, but the recordings sheet has no ${course} class that day -- the timetable slot may have been a different course`);
    } else if (r && !a && date < today) {
      warnOnce(`${key}|recording-only`, "no attendance marked", label,
        `${course} session ${fmt(r)} was held on ${date} (it's recorded) but attendance never marked it -- check the attendance sheet and attendance's run log`);
    }
  }
  if (changed) writeJsonAtomic(warnedFile, warned);
}
