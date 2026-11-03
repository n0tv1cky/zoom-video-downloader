#!/usr/bin/env node
// Downloads Zoom class recordings listed in a Google Sheet, before the share
// links expire. Reused across terms by editing config.json (sheet id/gid,
// column headers, output dir) -- no code changes needed.
//
// Usage:
//   npm install
//   node download-recordings.mjs [--dry-run] [--limit N] [--config path/to/config.json] [--headed]
//
// The recordings sheet is read via the Google Sheets API using your own
// OAuth login (one-time consent, cached after) -- see config.json's
// "googleOAuth" section. Only the Zoom side needs a real browser; by default
// that drives a separate, dedicated Chrome profile (one-time login, cached
// after) -- see config.json's "chrome" section. Runs headless by default (no
// visible window, no lid-open-Mac requirement); pass --headed for the
// one-time interactive login, or to re-login if the saved session expires.

import puppeteer from "puppeteer";
import { google } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { execSync, spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { format } from "node:util";
import { createHash } from "node:crypto";
import { mergeLocalConfig } from "./lib/configLocal.mjs";
import { probeDurationSeconds, detectSilenceGaps, pickCutPoints, splitByCutPoints } from "./lib/continuousSplit.mjs";
import { writeSessionLedger, crossCheckAttendance } from "./lib/sessionLedger.mjs";

// Mirrors every console.log/console.error call into logLines (in addition to
// actually printing, unchanged) so a manual run can email itself a report
// exactly like daily-check.sh's redirect-to-$SYNC_LOG does -- see
// maybeAutoReport below. Confirmed live 2026-09-12: running this file
// directly (as opposed to through daily-check.sh) three separate times left
// three real outcomes -- two failures and a fix -- with no report email at
// all, because send-report.mjs was never invoked for any of them.
const logLines = [];
const rawConsoleLog = console.log.bind(console);
const rawConsoleError = console.error.bind(console);
console.log = (...args) => {
  logLines.push(format(...args));
  rawConsoleLog(...args);
};
console.error = (...args) => {
  logLines.push(format(...args));
  rawConsoleError(...args);
};

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const configIdx = args.indexOf("--config");
const CONFIG_PATH = configIdx !== -1 ? args[configIdx + 1] : new URL("./config.json", import.meta.url).pathname;
// Headless by default (needs no visible window/lid-open Mac -- verified this
// still works for both the login-state check and the play-and-capture-src
// flow that grabClipUrls relies on). --headed forces a visible window, only
// needed for the one-time interactive login the first time a profile signs
// in, or to re-authenticate if the saved session ever expires.
const HEADED = args.includes("--headed");

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// Resolves a config path against the config file's own directory (not
// process.cwd()) so relative paths like "../../docs/recordings/videos" work
// the same whether you run `npm run sync` from this folder or elsewhere.
function resolveConfigPath(configDir, p) {
  const expanded = expandHome(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
}

function defaultChromeUserDataDir() {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Google", "Chrome");
    case "win32":
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
    default:
      return path.join(home, ".config", "google-chrome");
  }
}

function loadConfig() {
  const configDir = path.dirname(CONFIG_PATH);
  const raw = mergeLocalConfig(configDir, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  raw.outputDir = resolveConfigPath(configDir, raw.outputDir);
  raw.stateFile = expandHome(raw.stateFile);
  raw.organizeByCourse = raw.organizeByCourse ?? true;
  raw.chrome = raw.chrome ?? {};
  raw.chrome.userDataDir = expandHome(raw.chrome.userDataDir || defaultChromeUserDataDir());
  raw.chrome.snapshotDir = expandHome(raw.chrome.snapshotDir || "~/.zoom-recordings-sync/chrome-snapshot");
  if (raw.chromeProfileDir) raw.chromeProfileDir = expandHome(raw.chromeProfileDir);
  raw.googleOAuth = raw.googleOAuth ?? {};
  raw.googleOAuth.clientSecretFile = resolveConfigPath(configDir, raw.googleOAuth.clientSecretFile || "./oauth-client.json");
  raw.googleOAuth.tokenFile = expandHome(raw.googleOAuth.tokenFile || "~/.zoom-recordings-sync/google-oauth-token.json");
  raw.driveUpload = raw.driveUpload ?? {};
  raw.driveUpload.enabled = raw.driveUpload.enabled ?? false;
  raw.driveUpload.organizeByCourse = raw.driveUpload.organizeByCourse ?? true;
  // Defaults to the outputDir's own folder name (e.g. "MSDSM_Batch6_Term1"),
  // so Drive mirrors the local docs/recordings/videos/<term>/<session>/
  // layout automatically -- next term just needs outputDir updated, same as
  // everything else, no separate Drive-specific setting required.
  raw.driveUpload.termFolderName = raw.driveUpload.termFolderName || path.basename(raw.outputDir);
  raw.driveUpload.deleteLocalAfterUpload = raw.driveUpload.deleteLocalAfterUpload ?? false;
  // Which Google account Drive work runs as. Drive bills a file's owner, not
  // the folder it's in, so uploads have to be made as the account whose
  // storage should pay (2026-11-03: the school account hit its quota; see
  // auth-personal-drive.mjs). The recordings sheet is still read as
  // googleOAuth.tokenFile's account, since that's who it's shared with.
  raw.driveUpload.tokenFile = expandHome(raw.driveUpload.tokenFile || raw.googleOAuth.tokenFile);
  // Maps the recordings sheet's short subject abbreviations (e.g. "ME") to
  // the program's canonical "DSM <N>" course codes, from the schedule
  // sheet's course legend table. Keys are matched case-insensitively.
  raw.subjectCodeMap = Object.fromEntries(Object.entries(raw.subjectCodeMap ?? {}).map(([k, v]) => [k.toUpperCase(), v]));
  return raw;
}

// Chrome refuses to enable remote debugging when userDataDir is its literal
// default location ("DevTools remote debugging requires a non-default data
// directory") -- a deliberate guard against automating a user's live
// profile. We work around it the same way Chrome intends: copy the real
// profile (cookies, login state) into a separate directory each run, so the
// session carries over without ever needing an interactive login.
const RSYNC_EXCLUDES = ["Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "blob_storage", "Service Worker/CacheStorage", "*.log"];

function syncProfileSnapshot(realUserDataDir, snapshotDir, profileDirectory) {
  fs.mkdirSync(snapshotDir, { recursive: true });
  const excludeArgs = RSYNC_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]);

  const localState = spawnSync("rsync", ["-a", "--delete", path.join(realUserDataDir, "Local State"), path.join(snapshotDir, "Local State")]);
  if (localState.status !== 0) throw new Error(`Failed to sync Chrome "Local State": ${localState.stderr}`);

  const profileSync = spawnSync("rsync", [
    "-a",
    "--delete",
    ...excludeArgs,
    `${path.join(realUserDataDir, profileDirectory)}/`,
    `${path.join(snapshotDir, profileDirectory)}/`,
  ]);
  if (profileSync.status !== 0) throw new Error(`Failed to sync Chrome profile "${profileDirectory}": ${profileSync.stderr}`);
}

function assertChromeNotRunning() {
  if (process.platform !== "darwin") return; // best-effort check; only wired up for macOS today
  const running = execSync('pgrep -x "Google Chrome" || true').toString().trim();
  if (running) {
    throw new Error(
      "Google Chrome is currently running. Quit it completely (Cmd+Q, not just close the window) and try again — " +
        "this script drives your real Chrome profile, which Chrome only allows one process to touch at a time."
    );
  }
}

function resolveSystemProfileDirectory(userDataDir, emailHint) {
  const localStatePath = path.join(userDataDir, "Local State");
  if (!fs.existsSync(localStatePath)) {
    console.warn(`Could not find ${localStatePath}; falling back to the "Default" Chrome profile.`);
    return "Default";
  }
  const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
  const cache = localState.profile?.info_cache ?? {};
  const hint = (emailHint ?? "").toLowerCase();
  for (const [dir, info] of Object.entries(cache)) {
    const candidates = [info.user_name, info.gaia_name, info.gaia_given_name].filter(Boolean).join(" ").toLowerCase();
    if (hint && candidates.includes(hint)) return dir;
  }
  console.warn(`Could not find a Chrome profile signed in as "${emailHint}"; falling back to "Default". Set chrome.profileDirectory in config.json to override.`);
  return "Default";
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return {};
  const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  // Older state files stored a flat {status, file, downloadedAt} per link,
  // from before upload tracking existed. Normalize to {download, upload} so
  // both features can be tracked independently going forward.
  for (const [link, entry] of Object.entries(raw)) {
    if (entry.status && !entry.download && !entry.upload) {
      raw[link] = { download: { status: entry.status, file: entry.file, error: entry.error, at: entry.downloadedAt ?? entry.attemptedAt } };
    }
  }
  return raw;
}

function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function splitField(value) {
  return String(value ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Surname-only fuzzy match against config.json's courseFaculty legend (course
// code -> known instructors, transcribed from the schedule sheet's own
// instructor legend). This exists to catch data-entry mistakes in the
// recordings sheet's Faculty column -- confirmed live 2026-09-06, two rows
// had two course codes' faculty names crossed with each other. Deliberately
// NEVER auto-corrects the faculty/filename: a name absent from the legend can
// just as easily be a real substitute lecturer (also confirmed live --
// DSM 101's "Prof. Arshad" is one of that course's own listed instructors,
// just not the usual one), so silently "fixing" it risks quietly relabeling a
// real substitute's recording as the regular professor's -- a worse, harder
// -to-notice error than the one this is meant to catch. Flagging it in the
// report email keeps a human in the loop instead.
function facultySurname(name) {
  const normalized = String(name ?? "")
    .toLowerCase()
    .replace(/^(prof\.?|dr\.?)\s*/g, "")
    .replace(/[.,]/g, "")
    .trim();
  const parts = normalized.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function matchesKnownFaculty(faculty, knownFaculty) {
  if (!knownFaculty || knownFaculty.length === 0) return true; // no legend entry for this course -- nothing to check against
  const surname = facultySurname(faculty);
  if (!surname) return true;
  return knownFaculty.some((known) => facultySurname(known) === surname);
}

function slug(text) {
  return String(text ?? "")
    .replace(/^(prof\.?|dr\.?|mr\.?|ms\.?|mrs\.?)\s+/i, "")
    .replace(/[()]/g, " ")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);

function formatDate(value) {
  // Fetched with valueRenderOption: UNFORMATTED_VALUE, a real date cell comes
  // through as a Sheets serial number (days since 1899-12-30) -- convert that
  // directly rather than parsing a locale-formatted string, which is
  // ambiguous for any day <= 12 (e.g. "05-08-2026": DD-MM or MM-DD?).
  const d = typeof value === "number" ? new Date(SHEETS_EPOCH_MS + value * 86_400_000) : new Date(value);
  if (Number.isNaN(d.getTime())) return slug(String(value));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// "7:00pm to 9:15pm" -> { startMin: 1140, endMin: 1275 } (minutes since
// midnight). Matches this sheet's observed "Time" column format exactly
// (no leading zero, lowercase am/pm, no space before it) -- returns null on
// anything else rather than guessing.
function parseTimeRange(timeStr) {
  const m = String(timeStr ?? "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})(am|pm)\s+to\s+(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!m) return null;
  const toMinutes = (h, mm, ampm) => {
    let hour = parseInt(h, 10) % 12;
    if (ampm.toLowerCase() === "pm") hour += 12;
    return hour * 60 + parseInt(mm, 10);
  };
  return { startMin: toMinutes(m[1], m[2], m[3]), endMin: toMinutes(m[4], m[5], m[6]) };
}

// Same Sheets-serial-to-Date logic as formatDate below, just exposed for
// day-of-week rather than a date string.
function dayType(dateValue) {
  const d = typeof dateValue === "number" ? new Date(SHEETS_EPOCH_MS + dateValue * 86_400_000) : new Date(dateValue);
  const day = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6 ? "weekend" : "weekday";
}

// Returns the official duration (minutes) of each of `groupSize` sessions
// sharing one continuous recording, in session order -- used only to weight
// where a split boundary is *expected* to fall (see pickCutPoints in
// lib/continuousSplit.mjs), never as the cut point itself. Falls back to
// null (equal weighting) when the schedule can't be matched confidently --
// this only narrows a search window, so an imprecise fallback here just
// means a slightly wider effective search, not a wrong cut.
function resolveSessionDurationsMinutes(row, groupSize, timeSlots) {
  const slots = timeSlots?.[dayType(row.date)];
  const range = parseTimeRange(row.time);
  if (!slots || !range) return null;

  // Slot start/end in config.json are plain "HH:MM" 24h strings, not the
  // am/pm sheet format -- parse those directly rather than reusing
  // parseTimeRange (which expects am/pm).
  const toMinutes24 = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };

  const anchorIdx = slots.findIndex((s) => Math.abs(toMinutes24(s.start) - range.startMin) <= 5);
  const start = anchorIdx === -1 ? 0 : anchorIdx;
  const candidate = slots.slice(start, start + groupSize);
  if (candidate.length !== groupSize) return null;
  return candidate.map((s) => toMinutes24(s.end) - toMinutes24(s.start));
}

function buildFileName(template, row) {
  return (
    template
      .replace("{courseCode}", slug(row.courseCode))
      .replace("{date}", formatDate(row.date))
      .replace("{faculty}", slug(row.faculty)) + (template.endsWith(".mp4") ? "" : ".mp4")
  ).replace(/\.mp4\.mp4$/, ".mp4");
}

// The recordings sheet's "Course Code with Session No." column uses each
// subject's short-form abbreviation (e.g. "ME (2)"), but the program's real
// course codes are the "DSM <N>" numbers from the schedule's course legend
// (e.g. ME = DSM 107) -- some subjects (DSM 101/102/103) already appear in
// that canonical form directly. Resolve a raw cell value like "ME (2)" into
// { subjectCode: "DSM 107", sessionNumber: "2", courseCodeWithSession: "DSM 107 (2)" }
// via config.json's subjectCodeMap (abbreviation -> canonical code), falling
// back to using the abbreviation unchanged if it's not in the map (so an
// unrecognized code degrades gracefully instead of breaking the run) --
// `resolved: false` marks that case so main() can hold the upload rather
// than filing it into a stray Drive folder.
//
// The sheet's format drifts (seen live): "DSM 101(18)" (no space), "dsm 103"
// (lowercase -- previously produced a separate "dsm-103" folder), bare
// "DSM 103" (no session number at all), and from 2026-10-06 "ME 11 (DS)" --
// session number written bare and a trailing faculty-initials tag (Deepak
// Sethia) in the parentheses where the session number used to be. That last
// one fell through to the unchanged-abbreviation fallback and created
// "ME-11-DS"/"ME-12-DS" Drive folders. A trailing parenthetical containing
// letters (and no digits) is an annotation, never a course -- notably "(DS)"
// must NOT be looked up in subjectCodeMap, where "DS" means DSM 103.
//
// One recording can also cover several sessions: "DSM 102 (12&13)" on
// 2026-10-10 (held as unrecognized until this was handled). Any list of
// numbers joined by &, comma, +, "and" or a dash becomes "12-13".
const SESSION_LIST = String.raw`\d+(?:\s*(?:&|,|\+|-|and)\s*\d+)*`;
function normalizeSessionList(text) {
  return text == null ? null : text.match(/\d+/g).join("-");
}

function resolveSubjectCode(rawCourseCode, subjectCodeMap) {
  const raw = String(rawCourseCode ?? "").trim().replace(/\s+/g, " ");
  const core = raw.replace(/\s*\([^()\d]*[A-Za-z][^()\d]*\)\s*$/, "").trim();
  let subjectCode = core;
  let sessionNumber = null;
  // Canonical "DSM <N>" first, so a bare "DSM 103" isn't misread as
  // abbreviation "DSM", session 103 by the abbreviation rule below.
  const dsm = core.match(new RegExp(String.raw`^DSM\s*-?\s*(\d+)\s*(?:\(\s*(${SESSION_LIST})\s*\))?$`, "i"));
  const abbr = core.match(new RegExp(String.raw`^([A-Za-z]+)\s*-?\s*(?:\(\s*(${SESSION_LIST})\s*\)|(\d+))?$`, "i"));
  if (dsm) {
    subjectCode = `DSM ${dsm[1]}`;
    sessionNumber = normalizeSessionList(dsm[2] ?? null);
  } else if (abbr) {
    subjectCode = subjectCodeMap[abbr[1].toUpperCase()] ?? abbr[1];
    sessionNumber = normalizeSessionList(abbr[2] ?? abbr[3] ?? null);
  }
  return {
    subjectCode,
    sessionNumber,
    courseCodeWithSession: sessionNumber ? `${subjectCode} (${sessionNumber})` : subjectCode,
    resolved: /^DSM \d+$/.test(subjectCode),
    rawCourseCode: raw,
  };
}

// One folder per subject, not per session -- e.g. "DSM 107" -> "DSM-107" so
// every ME/DSM-107 recording lands together regardless of session number.
function courseFolder(subjectCode) {
  return slug(subjectCode) || "Uncategorized";
}

async function waitForLogin(page, rl) {
  // Headless has no visible window for a human to log in to, so waiting on
  // rl.question here would just hang forever unattended (e.g. under
  // launchd) with no way to ever recover. Fail loudly and immediately
  // instead, with the actual fix: re-run once with --headed to refresh the
  // saved session in the dedicated Chrome profile, then unattended headless
  // runs work again until it expires next.
  if (!HEADED) {
    throw new Error("Zoom/Google is asking to sign in, but this is running headless (no visible window). Re-run with --headed once to log in interactively; the session will be saved and reused headlessly after that.");
  }
  await rl.question(
    "\nA Chrome window has opened. If it's showing a Google/Zoom sign-in page, log in there now.\nPress Enter here once you're signed in and the page has loaded...\n"
  );
}

// drive.file (access limited to files/folders the app itself creates) isn't
// enough here: we need to create files inside a pre-existing folder the user
// picked, which that scope doesn't grant without a Picker-based consent flow.
// Full drive access is broader than ideal, but appropriate for a personal,
// unpublished OAuth client acting on the owner's own account.
const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly", "https://www.googleapis.com/auth/drive"];

function loadSavedGoogleAuth(tokenFile) {
  if (!fs.existsSync(tokenFile)) return null;
  return google.auth.fromJSON(JSON.parse(fs.readFileSync(tokenFile, "utf8")));
}

function saveGoogleAuth(tokenFile, client, clientSecretFile) {
  const keys = JSON.parse(fs.readFileSync(clientSecretFile, "utf8"));
  const key = keys.installed ?? keys.web;
  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, payload);
}

async function getGoogleAuthClient(clientSecretFile, tokenFile) {
  const saved = loadSavedGoogleAuth(tokenFile);
  if (saved) return saved;

  console.log("\nNo cached Google login found -- opening a browser tab for one-time sign-in...");
  const client = await authenticate({ scopes: GOOGLE_SCOPES, keyfilePath: clientSecretFile });
  if (client.credentials?.refresh_token) saveGoogleAuth(tokenFile, client, clientSecretFile);
  return client;
}

async function fetchRecordingsSheet(authClient, sheetId, gid) {
  const sheets = google.sheets({ version: "v4", auth: authClient });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const targetSheet = meta.data.sheets.find((s) => String(s.properties.sheetId) === String(gid)) ?? meta.data.sheets[0];

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: targetSheet.properties.title,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const [header, ...rows] = res.data.values ?? [];
  if (!header) return [];
  return rows.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""])));
}

const driveFolderCache = new Map();

async function findOrCreateDriveFolder(drive, parentId, name) {
  const cacheKey = `${parentId}/${name}`;
  if (driveFolderCache.has(cacheKey)) return driveFolderCache.get(cacheKey);

  const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = `name = '${escapedName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const existing = await drive.files.list({ q, fields: "files(id, name)", pageSize: 1 });
  if (existing.data.files?.length) {
    driveFolderCache.set(cacheKey, existing.data.files[0].id);
    return existing.data.files[0].id;
  }

  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    fields: "id",
  });
  driveFolderCache.set(cacheKey, created.data.id);
  return created.data.id;
}

async function md5OfFile(filePath) {
  const hash = createHash("md5");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function uploadToDrive(drive, driveConfig, termFolderId, courseFolderName, localPath, fileName) {
  const parentId = driveConfig.organizeByCourse ? await findOrCreateDriveFolder(drive, termFolderId, courseFolderName) : termFolderId;

  // An upload can fail client-side (timeout/connection drop) after Drive has
  // already committed the file -- confirmed live 2026-09-23: DSM-101-18 was
  // logged as a failed upload at 09:13, the same-day retry uploaded it again
  // at 09:57, leaving two byte-identical copies on Drive with only the second
  // tracked in state. Adopt an identical (same name + MD5) file already in
  // the folder instead of uploading another copy. Content match, not name
  // alone, so a stale wrong file of the same name (see
  // handleContinuousRecording) is never adopted in place of the right one.
  const escapedName = fileName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const existing = await drive.files.list({
    q: `name = '${escapedName}' and '${parentId}' in parents and trashed = false`,
    fields: "files(id, webViewLink, size, md5Checksum)",
  });
  const localSize = String(fs.statSync(localPath).size);
  const sameSize = (existing.data.files ?? []).filter((f) => f.size === localSize);
  if (sameSize.length > 0) {
    const localMd5 = await md5OfFile(localPath);
    const match = sameSize.find((f) => f.md5Checksum === localMd5);
    if (match) {
      console.log(`Identical file already on Drive (an earlier upload that reported failure but went through) -- reusing ${match.id}`);
      return { id: match.id, webViewLink: match.webViewLink };
    }
  }

  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [parentId] },
    media: { mimeType: "video/mp4", body: fs.createReadStream(localPath) },
    fields: "id, webViewLink",
  });
  return res.data;
}

function parseRows(rawRows, columns) {
  // A second class recorded the same day can appear as its own row with its
  // Date (and S.No/link-active-window) cells vertically merged into the row
  // above -- the Sheets API only returns a value for a merge's top-left
  // cell, so those cells come back blank on every row but the first. Forward
  // -fill from the last non-blank date seen so a merged-away cell inherits
  // the date it's visually grouped under, instead of formatDate() falling
  // back to an empty filename segment.
  let lastDate = "";
  return rawRows
    .map((r) => {
      const rawDate = r[columns.date];
      if (rawDate !== "" && rawDate != null) lastDate = rawDate;
      return {
        date: rawDate !== "" && rawDate != null ? rawDate : lastDate,
        time: r[columns.time],
        courseCode: r[columns.courseCode],
        faculty: r[columns.faculty],
        linkActiveTo: r[columns.linkActiveTo],
        link: r[columns.link],
      };
    })
    .filter((r) => r.link && String(r.link).startsWith("http"));
}

// A single Zoom link can cover multiple back-to-back class sessions recorded
// as separate clips within one meeting occurrence (Zoom's own multi-clip
// player -- see grabClipUrls below). The sheet marks this by slash-joining
// multiple course codes/faculty in one row, e.g. "DSM 101 (1)/ ME (2)".
// Expand such a row into one entry per session, sharing the link but each
// tracked (and named) independently.
function expandRowIntoSessions(row, subjectCodeMap) {
  const rawCourseCodes = splitField(row.courseCode);
  if (rawCourseCodes.length <= 1) {
    const resolved = resolveSubjectCode(row.courseCode, subjectCodeMap);
    return [
      {
        ...row,
        courseCode: resolved.courseCodeWithSession,
        subjectCode: resolved.subjectCode,
        sessionNumber: resolved.sessionNumber,
        codeResolved: resolved.resolved,
        rawCourseCode: resolved.rawCourseCode,
        clipIndex: 0,
        expectedClips: 1,
        stateKey: row.link,
      },
    ];
  }
  const faculties = splitField(row.faculty);
  return rawCourseCodes.map((rawCourseCode, i) => {
    const resolved = resolveSubjectCode(rawCourseCode, subjectCodeMap);
    return {
      ...row,
      courseCode: resolved.courseCodeWithSession,
      subjectCode: resolved.subjectCode,
      sessionNumber: resolved.sessionNumber,
      codeResolved: resolved.resolved,
      rawCourseCode: resolved.rawCourseCode,
      faculty: faculties[i] ?? faculties[faculties.length - 1] ?? row.faculty,
      clipIndex: i,
      expectedClips: rawCourseCodes.length,
      stateKey: `${row.link}#clip${i}`,
    };
  });
}

// A class's identity is (course, date, start time); "session N" is only a
// label derived from it: N = the Nth class of that course actually held,
// in date/time order -- the rule agreed across this sync, projects/attendance
// and projects/msdsm-notes (2026-10-14). The recordings sheet's own
// "(N)" labels drifted every way possible (numbers repeated across dates,
// left out, 24 skipped, an extra 09-19 class never counted) and needed a
// growing pile of hand-typed corrections; deriving the number makes every
// one of them unnecessary. The sheet's label is still kept, as
// sheetSessionNumber, and a disagreement is flagged -- not obeyed.
//
// Held is not the same as recorded: DSM 102 met on 2026-09-08 (the sheet and
// timetable both number the 09-11 class as 9) but no recording was ever
// listed. config.json's heldWithoutRecording lists such classes so they still
// take their place in the count. A recording covering several sessions
// ("DSM 102 (12&13)") takes as many places as the sheet gives it numbers.
function startMinutes(timeText) {
  const m = String(timeText ?? "").match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i);
  if (!m) return 0;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3] ?? "")) h += 12;
  if (!m[3]) h = Number(m[1]);
  return h * 60 + Number(m[2] ?? 0);
}

function sessionStartTime(session) {
  return String(session.time ?? "").split(/\s+to\s+/i)[0].trim().toLowerCase();
}

function classKey(session) {
  return `${formatDate(session.date)} ${sessionStartTime(session)} ${session.subjectCode}`;
}

// config.json's sessionOverrides: hand-confirmed corrections to anything
// else a sheet row got wrong -- currently only faculty names crossed between
// courses -- keyed the same "<YYYY-MM-DD> <start time> <DSM code>" way. An
// entry whose key no longer matches any class is just noted.
function applyClassOverrides(sessions, overrides = {}) {
  const used = new Set();
  const result = sessions.map((s) => {
    const o = s.codeResolved ? overrides[classKey(s)] : null;
    if (!o || typeof o !== "object") return s;
    used.add(classKey(s));
    return { ...s, faculty: o.faculty ?? s.faculty };
  });
  for (const key of Object.keys(overrides)) {
    if (key !== "note" && !used.has(key)) console.log(`NOTE  sessionOverrides entry "${key}" matched no session in the sheet`);
  }
  return result;
}

function deriveSessionNumbers(sessions, heldWithoutRecording = []) {
  const entries = [
    ...sessions.filter((s) => s.codeResolved).map((s, i) => ({ s, i })),
    ...heldWithoutRecording.map((h) => ({ placeholder: true, course: h.course, date: h.date, start: h.start })),
  ].map((e) => {
    const course = e.placeholder ? e.course : e.s.subjectCode;
    const date = e.placeholder ? e.date : formatDate(e.s.date);
    const start = startMinutes(e.placeholder ? e.start : sessionStartTime(e.s));
    const width = e.placeholder ? 1 : Math.max(1, String(e.s.sessionNumber ?? "").split("-").filter(Boolean).length);
    return { ...e, course, date, start, width, order: e.placeholder ? -1 : e.s.clipIndex };
  });
  entries.sort((a, b) => a.course.localeCompare(b.course) || a.date.localeCompare(b.date) || a.start - b.start || a.order - b.order);

  const derived = new Map();
  let course = null;
  let n = 0;
  for (const e of entries) {
    if (e.course !== course) {
      course = e.course;
      n = 0;
    }
    const label = e.width > 1 ? `${n + 1}-${n + e.width}` : String(n + 1);
    n += e.width;
    if (!e.placeholder) derived.set(e.s, label);
  }
  return sessions.map((s) => {
    if (!derived.has(s)) return s;
    const sessionNumber = derived.get(s);
    return { ...s, sheetSessionNumber: s.sessionNumber, sessionNumber, courseCode: `${s.subjectCode} (${sessionNumber})` };
  });
}

async function waitForVideoSrc(page, excludeSrc) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    let src = null;
    try {
      src = await page.evaluate(() => {
        const v = document.querySelector("video");
        const s = v?.currentSrc || v?.src || "";
        return s.startsWith("http") ? s : null;
      });
    } catch (err) {
      // Advancing to the next clip is a real client-side navigation (the
      // page's own JS does it, not us) -- polling can catch the frame
      // mid-navigation, which throws this specific transient error. Just
      // retry on the next tick once the new context settles.
      if (!/Execution context was destroyed|Target closed|detached Frame/.test(err.message)) throw err;
    }
    if (src && src !== excludeSrc) return src;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(excludeSrc ? "Timed out waiting for the next clip to load" : "Timed out waiting for video source");
}

// Returns the signed mp4 URL for every clip in this share link, in order.
// Zoom's player reports how many clips a meeting occurrence has via its
// play/info API (result.totalClips); when there's more than one, reaching
// the end of a clip auto-advances the player to the next one (a real
// client-side navigation to a new /rec/play/<id> URL with a new signed
// video src) -- the same thing a "forward" control in the UI triggers. We
// replicate that by seeking each clip to ~its end and letting it play the
// last moment out, rather than needing to find/click that control directly.
async function grabClipUrls(page, shareLink, rl) {
  let totalClips = 1;
  const onResponse = async (res) => {
    if (!res.url().includes("/nws/recording/1.0/play/info")) return;
    try {
      const json = await res.json();
      if (json?.result?.totalClips) totalClips = json.result.totalClips;
    } catch {}
  };
  page.on("response", onResponse);

  try {
    await page.goto(shareLink, { waitUntil: "networkidle2", timeout: 60_000 });

    if (page.url().includes("accounts.google.com") || page.url().includes("zoom.us/signin")) {
      await waitForLogin(page, rl);
      await page.goto(shareLink, { waitUntil: "networkidle2", timeout: 60_000 });
    }

    // The player is a JS-rendered SPA region, not necessarily present the
    // instant the network goes idle -- wait for the <video> element itself.
    await page.waitForSelector("video", { timeout: 20_000 });

    // Nudge playback every way that might work: Zoom only assigns the real
    // signed src in response to something resembling a genuine interaction,
    // and its Play control's exact markup isn't guaranteed, so try several.
    await page.evaluate(() => {
      const playable = Array.from(document.querySelectorAll('button, [role="button"]')).find(
        (el) => (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase() === "play"
      );
      playable?.click();
      const v = document.querySelector("video");
      v?.click?.();
      v?.play?.().catch(() => {});
    });

    const clips = [await waitForVideoSrc(page)];

    for (let i = 1; i < totalClips; i++) {
      await page.waitForFunction(() => !isNaN(document.querySelector("video")?.duration), { timeout: 20_000 });
      const previousSrc = clips[clips.length - 1];
      await page.evaluate(() => {
        const v = document.querySelector("video");
        v.muted = true;
        v.currentTime = Math.max(0, v.duration - 0.5);
        v.play().catch(() => {});
      });
      clips.push(await waitForVideoSrc(page, previousSrc));
    }

    return clips;
  } finally {
    page.off("response", onResponse);
  }
}

async function downloadToFile(page, mp4Url, outputDir, fileName) {
  // Fetching + buffering the ~150MB+ response *inside* the page (fetch().blob())
  // reliably fails partway through the body with a bare "TypeError: Failed to
  // fetch" on Puppeteer's bundled Chrome for Testing -- reproducible even with
  // no CDP involvement at all, so it's a body-streaming limit, not a
  // CSP/CORS/download-interception issue. Puppeteer's own response.buffer()
  // (CDP Network.getResponseBody) doesn't fare better: it hangs indefinitely
  // on a body this large. The reliable path is to do the actual byte transfer
  // in Node, replaying the same session as an authenticated request (cookies
  // + Referer + User-Agent lifted from the live page) and streaming straight
  // to disk -- no in-memory buffering on either side.
  const cookies = await page.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const userAgent = await page.browser().userAgent();

  const baseHeaders = { Cookie: cookieHeader, Referer: page.url(), "User-Agent": userAgent };

  // Stream to a .partial sibling first, then rename onto the real path only
  // once the transfer has fully succeeded. A killed/crashed/interrupted
  // download (confirmed to happen -- see git history around 2026-08-25:
  // a backgrounded run getting killed left a truncated 20-second file that
  // the resume logic below then trusted as a complete download and uploaded
  // as-is) now can only ever leave behind an orphaned .partial file, never a
  // corrupt file at the path localFileExists checks -- even under a hard
  // kill with no chance to run catch/cleanup, since the rename only happens
  // after pipeline() has already resolved successfully.
  //
  // A dropped connection mid-body ("terminated", undici's error for it) used
  // to throw away the whole transfer -- confirmed live 2026-10-17: the
  // DSM-101 10-16 clip failed this way at 09:00 and again on the 09:53
  // retry, while the other clip from the same recording came through fine.
  // Resume from the bytes already on disk with a Range request instead, a
  // few times with backoff, and only accept the file once its size matches
  // the total the server reported -- so a short body can never pass as done.
  const targetPath = path.join(outputDir, fileName);
  const partialPath = `${targetPath}.partial`;
  const MAX_ATTEMPTS = 6;
  fs.rmSync(partialPath, { force: true });
  let expectedTotal = null;
  for (let attempt = 1; ; attempt++) {
    const have = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
    try {
      const res = await fetch(mp4Url, { headers: have > 0 ? { ...baseHeaders, Range: `bytes=${have}-` } : baseHeaders });
      const resumed = have > 0 && res.status === 206;
      if (!res.ok || !res.body) {
        const err = new Error(`Video download failed: HTTP ${res.status}`);
        err.fatal = res.status === 401 || res.status === 403 || res.status === 404;
        throw err;
      }
      if (have > 0 && !resumed) fs.rmSync(partialPath, { force: true }); // server ignored Range: start over
      const range = res.headers.get("content-range")?.match(/\/(\d+)$/);
      const length = Number(res.headers.get("content-length")) || null;
      expectedTotal = range ? Number(range[1]) : length != null ? (resumed ? have + length : length) : expectedTotal;
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(partialPath, { flags: resumed ? "a" : "w" }));
      const size = fs.statSync(partialPath).size;
      if (expectedTotal != null && size < expectedTotal) throw new Error(`body ended early (${size} of ${expectedTotal} bytes)`);
      fs.renameSync(partialPath, targetPath);
      return targetPath;
    } catch (err) {
      const got = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
      if (err.fatal || attempt >= MAX_ATTEMPTS) {
        fs.rmSync(partialPath, { force: true });
        throw new Error(`${err.message}${attempt > 1 ? ` (after ${attempt} attempts, ${(got / 1e6).toFixed(0)}MB received)` : ""}`);
      }
      console.log(`  connection dropped at ${(got / 1e6).toFixed(0)}MB${expectedTotal ? ` of ${(expectedTotal / 1e6).toFixed(0)}MB` : ""} (${err.message}) -- resuming, attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

async function launchBrowser(config) {
  const useSystemProfile = config.chrome?.useSystemProfile !== false;

  if (useSystemProfile) {
    assertChromeNotRunning();
    const profileDirectory =
      config.chrome.profileDirectory || resolveSystemProfileDirectory(config.chrome.userDataDir, config.chrome.profileEmailHint);
    console.log(`Using your Chrome profile "${profileDirectory}" (synced from ${config.chrome.userDataDir})`);
    syncProfileSnapshot(config.chrome.userDataDir, config.chrome.snapshotDir, profileDirectory);
    return puppeteer.launch({
      channel: "chrome",
      headless: false,
      userDataDir: config.chrome.snapshotDir,
      args: [`--profile-directory=${profileDirectory}`, "--no-first-run", "--no-default-browser-check"],
      defaultViewport: null,
    });
  }

  // Fallback: a separate, dedicated automation profile that logs in once and
  // persists thereafter (set chrome.useSystemProfile: false to use this).
  //
  // channel: "chrome" launches your actual installed Google Chrome app
  // instead of Puppeteer's bundled "Chrome for Testing" binary. That bundled
  // binary is what was causing repeated macOS TCC "Allow access" prompts
  // (filesystem, sometimes Music) -- its binary identity changes whenever
  // Puppeteer/its Chrome build gets updated, so macOS kept treating it as a
  // "new" app needing fresh permission grants. Real Chrome is one stable,
  // already-trusted, notarized binary, so this doesn't happen. Verified this
  // doesn't require quitting your everyday Chrome first (unlike the
  // useSystemProfile branch above): it's a completely separate profile
  // directory, so Chrome runs it as an independent instance.
  //
  // headless (true unless --headed) means this no longer needs the laptop
  // lid open -- verified both the login-state check and grabClipUrls' full
  // play-and-capture-signed-src flow work identically headless. Only the
  // very first login (or a re-login if the saved session ever expires) needs
  // a visible window; see waitForLogin's headless guard above.
  fs.mkdirSync(config.chromeProfileDir, { recursive: true });
  return puppeteer.launch({
    channel: "chrome",
    headless: !HEADED,
    userDataDir: config.chromeProfileDir,
    defaultViewport: { width: 1280, height: 900 },
  });
}

async function main() {
  const config = loadConfig();
  fs.mkdirSync(config.outputDir, { recursive: true });
  const state = loadState(config.stateFile);

  console.log(`Fetching recordings sheet for "${config.term}"...`);
  const authClient = await getGoogleAuthClient(config.googleOAuth.clientSecretFile, config.googleOAuth.tokenFile);
  const rawRows = await fetchRecordingsSheet(authClient, config.recordingsSheet.id, config.recordingsSheet.gid);
  const driveAuth = config.driveUpload.enabled ? loadSavedGoogleAuth(config.driveUpload.tokenFile) : null;
  if (config.driveUpload.enabled && !driveAuth) {
    throw new Error(`No Drive login at ${config.driveUpload.tokenFile} -- run: node auth-personal-drive.mjs`);
  }
  const rows = parseRows(rawRows, config.columns);
  const sessions = deriveSessionNumbers(
    applyClassOverrides(rows.flatMap((row) => expandRowIntoSessions(row, config.subjectCodeMap)), config.sessionOverrides),
    config.heldWithoutRecording?.classes
  );
  console.log(
    `Found ${rows.length} row(s) with a recording link` +
      (sessions.length !== rows.length ? ` (${sessions.length} sessions after splitting combined-link rows).` : ".")
  );

  // All sessions sharing one Zoom link, keyed by link -- includes sessions
  // that are already fully uploaded, unlike `pending`/`toDownload` below.
  // Needed because a continuous (never stopped/restarted) recording can
  // mean session 1 already got uploaded as the WHOLE recording (mislabeled)
  // before this file existed to fix that -- detecting and correcting that
  // requires seeing every session for the link, not just the still-pending
  // ones. See handleContinuousRecording below.
  const sessionsByLink = new Map();
  for (const s of sessions) {
    if (!sessionsByLink.has(s.link)) sessionsByLink.set(s.link, []);
    sessionsByLink.get(s.link).push(s);
  }

  // Two different sessions can produce the exact same file name when the
  // sheet repeats a session number on one date -- confirmed live 2026-09-19,
  // "MC (3)/ DSM 101 (12)" in the morning and "DSM 101 (12)/ DSM 103/ DSM 102
  // (10)" in the afternoon, both -> DSM-101-12_2026-09-19_Arshad.mp4. Since
  // an existing local file is trusted as "already downloaded", the second
  // session could pick up (and upload) the first one's file. Give every
  // repeat after the first (sheet order) a "_2", "_3", ... suffix.
  const fileNameCounts = new Map();
  const fileNames = sessions.map((session) => {
    const base = buildFileName(config.fileNameTemplate, session);
    const key = `${courseFolder(session.subjectCode)}/${base}`.toLowerCase();
    const n = (fileNameCounts.get(key) ?? 0) + 1;
    fileNameCounts.set(key, n);
    return n === 1 ? base : base.replace(/\.mp4$/, `_${n}.mp4`);
  });

  const plannedPaths = new Set(
    sessions.map((session, i) => {
      const dir = config.organizeByCourse ? path.join(config.outputDir, courseFolder(session.subjectCode)) : config.outputDir;
      return path.join(dir, fileNames[i]);
    })
  );

  const plan = sessions.map((session, i) => {
    const fileName = fileNames[i];
    const courseFolderName = courseFolder(session.subjectCode);
    const targetDir = config.organizeByCourse ? path.join(config.outputDir, courseFolderName) : config.outputDir;
    const targetPath = path.join(targetDir, fileName);
    const entry = state[session.stateKey] ?? {};
    let localFileExists = fs.existsSync(targetPath);
    const uploaded = !config.driveUpload.enabled || entry.upload?.status === "uploaded";
    // A session downloaded under an older name (e.g. held for an
    // unrecognized course code, then resolved by a parser/config fix) would
    // otherwise be re-fetched from Zoom under its new name -- and the share
    // link may have expired by then. Move the already-downloaded file over.
    const priorFile = entry.download?.status === "downloaded" ? entry.download.file : null;
    // Never take a file that is some other session's current target (e.g. a
    // collision suffix shifted because a same-name row was inserted earlier).
    if (!localFileExists && !uploaded && priorFile && priorFile !== targetPath && !plannedPaths.has(priorFile) && fs.existsSync(priorFile)) {
      if (DRY_RUN) {
        console.log(`WOULD MOVE ${priorFile} -> ${targetPath}`);
      } else {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.renameSync(priorFile, targetPath);
        state[session.stateKey] = { ...entry, download: { ...entry.download, file: targetPath } };
        saveState(config.stateFile, state);
        console.log(`Moved earlier download to its corrected name: ${priorFile} -> ${targetPath}`);
      }
      localFileExists = true;
    }
    // A session stuck needing a human to pick the split point (see
    // handleContinuousRecording / docs/continuous-recording-splitting.md)
    // must not be treated as needing a normal (re-)download or upload --
    // there's no clip to fetch and no local file to upload until
    // confirm-split.mjs resolves it.
    const pendingManualSplit = entry.download?.status === "pending-manual-split";
    // A session only needs re-fetching from Zoom if we don't have the file
    // locally AND we don't have a durable copy on Drive either. Once
    // uploaded, deleteLocalAfterUpload may have removed the local file on
    // purpose -- that's not "missing," it's "no longer needed."
    const needsDownload = !localFileExists && !uploaded && !pendingManualSplit;
    // A course code that didn't resolve to a canonical "DSM <N>" (a new
    // sheet format the parser doesn't know yet) still gets downloaded --
    // Zoom share links expire -- but isn't uploaded, so it can't create a
    // stray Drive folder like "ME-11-DS". Reported on every run (not just
    // once) until resolveSubjectCode/subjectCodeMap is fixed, since that fix
    // is ours to make, unlike a sheet typo.
    const heldUnresolvedCode = !session.codeResolved;
    const needsUpload = config.driveUpload.enabled && !uploaded && !pendingManualSplit && !heldUnresolvedCode;
    return { session, fileName, courseFolderName, targetDir, targetPath, localFileExists, uploaded, pendingManualSplit, heldUnresolvedCode, needsDownload, needsUpload };
  });
  const planByStateKey = new Map(plan.map((p) => [p.session.stateKey, p]));

  // Flag-only, never auto-corrects -- see matchesKnownFaculty's comment above
  // for why. Runs over every session in the sheet, not just pending ones, so
  // a mismatch is caught the same day it's entered even if that session was
  // already downloaded/uploaded on a prior run. There's no control over the
  // recordings sheet itself (someone else maintains it), so a mistake there
  // can't be expected to ever get corrected -- state.facultyWarned makes this
  // a one-time flag per session (keyed the same as download/upload status)
  // instead of nagging on every single future run forever.
  //
  // The same flag-once treatment covers the other sheet mistakes seen live:
  // a course code with no session number ("DSM 103" on 2026-09-14/09-19) and
  // one session number listed for more than one class (e.g. "DSM 101 (12)"
  // on 09-10, 09-12 and twice on 09-19). Neither can be corrected from here
  // (the right number isn't knowable), so they're flagged, never renamed.
  // state[key].warned[kind] records each one; facultyWarned is the older
  // field for the same thing, still honored for "unexpected faculty".
  let warningsStateChanged = false;
  function warnOnce(p, kind, message) {
    const entry = state[p.session.stateKey] ?? {};
    if (entry.warned?.[kind] || (kind === "unexpected faculty" && entry.facultyWarned)) return;
    console.log(`WARN  (${kind}) ${p.fileName}: ${message}`);
    if (!DRY_RUN) {
      state[p.session.stateKey] = { ...entry, warned: { ...entry.warned, [kind]: true } };
      warningsStateChanged = true;
    }
  }

  // sheet label minus derived number, per class, compared in date order per course
  const labelGap = (p) => {
    const sheet = parseInt(String(p.session.sheetSessionNumber ?? ""), 10);
    const derived = parseInt(String(p.session.sessionNumber ?? ""), 10);
    return Number.isNaN(sheet) || Number.isNaN(derived) ? null : sheet - derived;
  };
  const previousInCourse = new Map();
  const byDate = plan
    .filter((p) => p.session.codeResolved)
    .sort((a, b) => formatDate(a.session.date).localeCompare(formatDate(b.session.date)) || startMinutes(sessionStartTime(a.session)) - startMinutes(sessionStartTime(b.session)));
  const lastSeen = new Map();
  for (const p of byDate) {
    previousInCourse.set(p, lastSeen.get(p.session.subjectCode) ?? null);
    lastSeen.set(p.session.subjectCode, p);
  }
  const labelGapChanged = (p) => {
    const gap = labelGap(p);
    if (gap === null) return true;
    const prev = previousInCourse.get(p);
    return (prev ? labelGap(prev) : 0) !== gap;
  };

  for (const p of plan) {
    if (!p.session.codeResolved) continue; // HOLD line below covers it, every run
    const known = config.courseFaculty?.[p.session.subjectCode];
    if (!matchesKnownFaculty(p.session.faculty, known)) {
      warnOnce(
        p,
        "unexpected faculty",
        `"${p.session.faculty}" is not a listed instructor for ${p.session.subjectCode}` + (known?.length ? ` (expected one of: ${known.join(", ")})` : "")
      );
    }
    // The number itself is derived (see deriveSessionNumbers); a sheet label
    // that disagrees is worth one look -- it usually means a sheet typo, but
    // it can also mean a class was held that has no recording, which belongs
    // in config.json's heldWithoutRecording.
    // Only a *change* in how far the sheet is off is news: one skipped
    // label (24, on 10-12) leaves every later DSM 101 label 1 high, and
    // re-flagging that on each new class (it did, 2026-10-17) is noise. So
    // compare this class's sheet-minus-derived gap with the previous class
    // of the same course, and flag only when it differs (or the sheet gives
    // no number at all).
    const since = config.heldWithoutRecording?.labelCheckSince;
    if (labelGapChanged(p) && (!since || formatDate(p.session.date) >= since)) {
      warnOnce(
        p,
        "sheet session number differs",
        `sheet says "${p.session.rawCourseCode}"; by date order this is ${p.session.subjectCode} session ${p.session.sessionNumber}` +
          " -- a sheet typo, or a class held without a recording (add it to heldWithoutRecording)"
      );
    }
  }
  if (warningsStateChanged) saveState(config.stateFile, state);

  // Keep already-uploaded Drive files named (and foldered) the way the plan
  // now names them -- otherwise a newly listed earlier class shifting the derived numbers, a parser fix
  // (2026-10-06's "ME 11 (DS)" uploaded into a stray "ME-11-DS" folder), or
  // a corrected sheet row only affects future uploads. Rename/move only,
  // never delete. state upload.fileName/folder records what Drive holds, so
  // after the first check this costs no API calls until a name changes.
  if (config.driveUpload.enabled) {
    const drive = google.drive({ version: "v3", auth: driveAuth });
    const folderNameCache = new Map();
    const folderName = async (id) => {
      if (!folderNameCache.has(id)) folderNameCache.set(id, (await drive.files.get({ fileId: id, fields: "name" })).data.name);
      return folderNameCache.get(id);
    };
    let reconcileTermFolderId = null;
    for (const p of plan) {
      const upload = state[p.session.stateKey]?.upload;
      if (upload?.status !== "uploaded" || !upload.fileId || p.heldUnresolvedCode) continue;
      if (upload.fileName === p.fileName && upload.folder === p.courseFolderName) continue;
      try {
        const file = (await drive.files.get({ fileId: upload.fileId, fields: "name, parents, trashed" })).data;
        if (file.trashed) continue;
        const currentFolder = await folderName(file.parents[0]);
        const wrongFolder = config.driveUpload.organizeByCourse && currentFolder !== p.courseFolderName;
        if (file.name !== p.fileName || wrongFolder) {
          const from = `${currentFolder}/${file.name}`;
          const to = `${wrongFolder ? p.courseFolderName : currentFolder}/${p.fileName}`;
          if (DRY_RUN) {
            console.log(`WOULD RENAME on Drive ${from} -> ${to}`);
            continue;
          }
          const update = { fileId: upload.fileId, requestBody: { name: p.fileName } };
          if (wrongFolder) {
            reconcileTermFolderId ??= await findOrCreateDriveFolder(drive, config.driveUpload.rootFolderId, config.driveUpload.termFolderName);
            update.addParents = await findOrCreateDriveFolder(drive, reconcileTermFolderId, p.courseFolderName);
            update.removeParents = file.parents.join(",");
          }
          await drive.files.update(update);
          console.log(`RENAMED on Drive ${from} -> ${to}`);
        }
        if (!DRY_RUN) {
          state[p.session.stateKey] = { ...state[p.session.stateKey], upload: { ...upload, fileName: p.fileName, folder: p.courseFolderName } };
          saveState(config.stateFile, state);
        }
      } catch (err) {
        console.log(`WARN: couldn't check/rename Drive file for ${p.fileName}: ${err.message}`);
      }
    }
  }

  // Publish the corrected numbering for the other tools, and check it
  // against attendance's independent count -- see lib/sessionLedger.mjs.
  const ledger = config.sessionLedger ?? {};
  if (!DRY_RUN && ledger.file) {
    writeSessionLedger(expandHome(ledger.file), plan, state, { term: config.term, formatDate, startTime: sessionStartTime });
  }
  if (ledger.attendanceRunsFile) {
    crossCheckAttendance({
      plan,
      runsFile: expandHome(ledger.attendanceRunsFile),
      warnedFile: expandHome(ledger.crossCheckWarnedFile ?? "~/.zoom-recordings-sync/attendance-crosscheck-warned.json"),
      since: ledger.crossCheckSince,
      formatDate,
      dryRun: DRY_RUN,
    });
  }

  // Tallied into a final `SUMMARY:` line so an unattended caller (see
  // send-report.mjs) can classify the run's outcome by parsing one line
  // instead of re-deriving counts from loosely-matched OK/FAIL/SKIP text.
  const counts = { downloaded: 0, uploaded: 0, fail: 0, skip: 0, pendingSplit: 0 };

  // The first HOLD for a session emails; later runs log "STILL HELD", which
  // the report shows only alongside an email that's going out anyway --
  // re-alerting on every 4-hourly run sent 7 identical emails for one
  // "DSM 102 (12&13)" recording over 2026-10-10..12.
  let heldStateChanged = false;
  for (const p of plan) {
    if (p.heldUnresolvedCode && !p.uploaded) {
      const entry = state[p.session.stateKey] ?? {};
      const tag = entry.warned?.held ? "STILL HELD" : "HOLD ";
      console.log(
        `${tag} (unrecognized course code) ${p.fileName}: "${p.session.rawCourseCode}" doesn't map to a DSM course -- ` +
          `${p.needsDownload ? "will download" : "downloaded"}, not uploaded until subjectCodeMap/resolveSubjectCode handles it`
      );
      if (!entry.warned?.held && !DRY_RUN) {
        state[p.session.stateKey] = { ...entry, warned: { ...entry.warned, held: true } };
        heldStateChanged = true;
      }
    } else if (p.pendingManualSplit) {
      console.log(`SKIP  (pending manual split -- run confirm-split.mjs ${p.session.stateKey}) ${p.fileName}`);
      counts.pendingSplit++;
    } else if (!p.needsDownload && !p.needsUpload) {
      console.log(`SKIP  (${p.localFileExists ? "already done" : "uploaded, local copy removed"}) ${p.fileName}`);
      counts.skip++;
    }
  }

  if (heldStateChanged) saveState(config.stateFile, state);

  const pending = plan.filter((p) => p.needsDownload || p.needsUpload).slice(0, LIMIT);
  if (pending.length === 0) {
    console.log("Nothing to do.");
    console.log(`SUMMARY: downloaded=${counts.downloaded} uploaded=${counts.uploaded} fail=${counts.fail} skip=${counts.skip} pendingSplit=${counts.pendingSplit}`);
    return;
  }

  if (DRY_RUN) {
    for (const p of pending) {
      if (p.needsDownload) console.log(`WOULD DOWNLOAD -> ${p.targetPath}`);
      else console.log(`WOULD UPLOAD (already downloaded) -> ${p.targetPath}`);
    }
    return;
  }

  const drive = config.driveUpload.enabled ? google.drive({ version: "v3", auth: driveAuth }) : null;
  const termFolderId = config.driveUpload.enabled
    ? await findOrCreateDriveFolder(drive, config.driveUpload.rootFolderId, config.driveUpload.termFolderName)
    : null;

  async function runUpload(p) {
    if (!config.driveUpload.enabled || p.uploaded || p.heldUnresolvedCode) return;
    console.log(`Uploading -> Drive/${config.driveUpload.termFolderName}/${p.courseFolderName}/${p.fileName}`);
    const uploaded = await uploadToDrive(drive, config.driveUpload, termFolderId, p.courseFolderName, p.targetPath, p.fileName);
    state[p.session.stateKey] = {
      ...state[p.session.stateKey],
      upload: { status: "uploaded", fileId: uploaded.id, webViewLink: uploaded.webViewLink, fileName: p.fileName, folder: p.courseFolderName, at: new Date().toISOString() },
    };
    saveState(config.stateFile, state);
    console.log(`OK    ${uploaded.webViewLink}`);
    counts.uploaded++;

    // Only delete after the upload above has actually succeeded (we're past
    // any throw at this point) and been recorded in stateFile -- never as a
    // side effect of merely attempting an upload.
    if (config.driveUpload.deleteLocalAfterUpload) {
      fs.rmSync(p.targetPath, { force: true });
      console.log(`Removed local copy (kept on Drive): ${p.targetPath}`);
      try {
        fs.rmdirSync(p.targetDir); // only succeeds if now empty; harmless no-op otherwise
      } catch {}
    }
  }

  function recordFailure(p, phase, err) {
    console.error(`FAIL  (${phase}) ${p.fileName}: ${err.message}`);
    state[p.session.stateKey] = { ...state[p.session.stateKey], [phase]: { status: "failed", error: err.message, at: new Date().toISOString() } };
    saveState(config.stateFile, state);
    counts.fail++;
  }

  // Handles the case where a shared Zoom link's recording was never
  // stopped/restarted between the classes it covers, so Zoom reports a
  // single clip where N sessions were expected (see
  // docs/continuous-recording-splitting.md for the full design). Downloads
  // the one clip once, finds a real inter-class silence gap inside a
  // schedule-derived search window per boundary, and splits+uploads
  // automatically when confident. `fullGroup` is every session sharing this
  // link (via sessionsByLink), not just the still-pending ones -- a session
  // already marked uploaded before this feature existed may actually hold
  // the WHOLE continuous recording mislabeled as just its own session (this
  // is exactly what happened live on 2026-08-27), so correcting it means
  // re-deriving and re-uploading that session too, then removing the old,
  // wrong Drive file.
  async function handleContinuousRecording(link, fullGroup, clipUrl) {
    const plans = fullGroup.map((s) => planByStateKey.get(s.stateKey));
    plans.sort((a, b) => a.session.clipIndex - b.session.clipIndex);

    console.log(`Continuous recording detected -- no stop/restart between ${plans.length} sessions. Downloading once and splitting locally.`);

    const rawDir = plans[0].targetDir;
    fs.mkdirSync(rawDir, { recursive: true });
    const rawFileName = `RAW_${plans.map((p) => slug(p.session.subjectCode)).join("_")}_${formatDate(plans[0].session.date)}.mp4`;

    // Reuse an already-downloaded raw file rather than re-fetching it -- if
    // a previous attempt got this far but failed during splitting/upload
    // (e.g. a session's own output folder didn't exist yet, hit live
    // 2026-08-27), there's no reason to re-download 2+ hours of video for a
    // retry that only needs the split/upload steps redone.
    const expectedRawPath = path.join(rawDir, rawFileName);
    let rawPath;
    if (fs.existsSync(expectedRawPath)) {
      console.log(`Reusing already-downloaded raw file -> ${expectedRawPath}`);
      rawPath = expectedRawPath;
    } else {
      try {
        rawPath = await downloadToFile(page, clipUrl, rawDir, rawFileName);
      } catch (err) {
        for (const p of plans) recordFailure(p, "download", err);
        return;
      }
    }

    let durationSec, cutPoints;
    try {
      durationSec = probeDurationSeconds(rawPath);
      const sessionDurationsMin = resolveSessionDurationsMinutes(plans[0].session, plans.length, config.timeSlots) ?? plans.map(() => 1);
      const silenceGaps = detectSilenceGaps(rawPath);
      cutPoints = pickCutPoints({ durationSec, sessionDurationsMin, silenceGaps, windowMin: 10 });
    } catch (err) {
      for (const p of plans) recordFailure(p, "download", err);
      return;
    }

    if (cutPoints.some((c) => !c.confident)) {
      console.log(
        `No confident silence gap found for at least one boundary -- leaving ${plans.length} session(s) pending-manual-split. Run confirm-split.mjs once with a real timestamp to finish.`
      );
      // Self-contained on purpose: confirm-split.mjs only needs to be given
      // one stateKey from this group and can read everything else (the raw
      // file, every session's own output path, and Drive upload details) off
      // this one state entry -- no need to re-fetch/re-parse the recordings
      // sheet just to finish a split that's otherwise fully determined.
      const groupStateKeys = plans.map((p) => p.session.stateKey);
      for (const p of plans) {
        state[p.session.stateKey] = {
          ...state[p.session.stateKey],
          download: {
            status: "pending-manual-split",
            rawFile: rawPath,
            groupStateKeys,
            targetPaths: plans.map((q) => q.targetPath),
            fileNames: plans.map((q) => q.fileName),
            courseFolderNames: plans.map((q) => q.courseFolderName),
            proposedCutsSeconds: cutPoints.map((c) => c.cutSeconds),
            searchWindows: cutPoints.map((c) => [c.windowStart, c.windowEnd]),
            at: new Date().toISOString(),
          },
        };
      }
      saveState(config.stateFile, state);
      counts.pendingSplit += plans.length;
      return;
    }

    const cutSeconds = cutPoints.map((c) => c.cutSeconds);
    console.log(`Splitting at ${cutSeconds.map((s) => s.toFixed(1)).join("s, ")}s (silence-detected, confident)`);
    // Each session can be a different subject/course folder (e.g.
    // DSM-101/DSM-102) -- only rawDir (the first session's folder) was
    // guaranteed to exist above, so ffmpeg would fail writing into any
    // other session's not-yet-created folder (hit live 2026-08-27).
    for (const p of plans) fs.mkdirSync(p.targetDir, { recursive: true });
    try {
      splitByCutPoints(rawPath, cutSeconds, plans.map((p) => p.targetPath));
    } catch (err) {
      for (const p of plans) recordFailure(p, "download", err);
      return;
    }

    for (const p of plans) {
      state[p.session.stateKey] = { ...state[p.session.stateKey], download: { status: "downloaded", file: p.targetPath, splitFrom: rawFileName, at: new Date().toISOString() } };
      saveState(config.stateFile, state);
      console.log(`OK    ${p.targetPath}`);
      counts.downloaded++;
    }
    fs.rmSync(rawPath, { force: true });

    for (const p of plans) {
      if (!config.driveUpload.enabled || p.heldUnresolvedCode) continue;
      const priorUpload = state[p.session.stateKey]?.upload;
      try {
        console.log(`Uploading -> Drive/${config.driveUpload.termFolderName}/${p.courseFolderName}/${p.fileName}`);
        const uploaded = await uploadToDrive(drive, config.driveUpload, termFolderId, p.courseFolderName, p.targetPath, p.fileName);
        state[p.session.stateKey] = {
          ...state[p.session.stateKey],
          upload: { status: "uploaded", fileId: uploaded.id, webViewLink: uploaded.webViewLink, fileName: p.fileName, folder: p.courseFolderName, at: new Date().toISOString() },
        };
        saveState(config.stateFile, state);
        console.log(`OK    ${uploaded.webViewLink}`);
        counts.uploaded++;

        // A prior upload for this exact session, from before this feature
        // existed, was actually the whole continuous recording mislabeled as
        // just this session (confirmed live 2026-08-27) -- now that we have
        // the correctly trimmed file, remove that stale/wrong Drive file
        // rather than leaving both versions there.
        if (priorUpload?.status === "uploaded" && priorUpload.fileId && priorUpload.fileId !== uploaded.id) {
          try {
            await drive.files.delete({ fileId: priorUpload.fileId });
            console.log(`Removed previous (incorrect, full-length) upload: ${priorUpload.fileId}`);
          } catch (err) {
            console.error(`WARN: failed to delete stale upload ${priorUpload.fileId}: ${err.message}`);
          }
        }

        if (config.driveUpload.deleteLocalAfterUpload) {
          fs.rmSync(p.targetPath, { force: true });
          console.log(`Removed local copy (kept on Drive): ${p.targetPath}`);
          try {
            fs.rmdirSync(p.targetDir);
          } catch {}
        }
      } catch (err) {
        recordFailure(p, "upload", err);
      }
    }
  }

  // Sessions that already have a local file but only need uploading don't
  // need a browser at all -- handle those first without paying for a Chrome
  // launch.
  for (const p of pending.filter((p) => !p.needsDownload)) {
    try {
      await runUpload(p);
    } catch (err) {
      recordFailure(p, "upload", err);
    }
  }

  const toDownload = pending.filter((p) => p.needsDownload);
  if (toDownload.length === 0) {
    console.log(`SUMMARY: downloaded=${counts.downloaded} uploaded=${counts.uploaded} fail=${counts.fail} skip=${counts.skip} pendingSplit=${counts.pendingSplit}`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const browser = await launchBrowser(config);
  const existingPages = await browser.pages();
  const page = existingPages[0] ?? (await browser.newPage());

  try {
    // Multiple sessions can share one Zoom link (see expandRowIntoSessions),
    // so group by link and fetch each link's clips only once -- re-opening
    // the share page always starts back at clip 1, so this also avoids
    // redundantly re-walking through clips we already have.
    const byLink = new Map();
    for (const p of toDownload) {
      if (!byLink.has(p.session.link)) byLink.set(p.session.link, []);
      byLink.get(p.session.link).push(p);
    }

    for (const [link, group] of byLink) {
      group.sort((a, b) => a.session.clipIndex - b.session.clipIndex);
      const multi = group[0].session.expectedClips > 1;
      console.log(`\nOpening -> ${link}${multi ? ` (${group.length} session(s) expected from this recording)` : ""}`);

      let clips;
      try {
        clips = await grabClipUrls(page, link, rl);
      } catch (err) {
        for (const p of group) recordFailure(p, "download", err);
        continue;
      }

      // Zoom reporting exactly 1 clip where more than 1 session was expected
      // means nobody stopped/restarted the recording between classes -- a
      // genuine single continuous recording, not a partial multi-clip
      // glitch (which would instead show up as some clips found, just fewer
      // than expected, still handled as a per-session failure below). Use
      // the FULL session group for this link (every session sharing it,
      // including ones already uploaded), not just `group` (only the
      // still-pending ones) -- see handleContinuousRecording's comment.
      const fullGroup = sessionsByLink.get(link) ?? group.map((p) => p.session);
      if (clips.length === 1 && fullGroup.length > 1) {
        await handleContinuousRecording(link, fullGroup, clips[0]);
        continue;
      }

      for (const p of group) {
        const clipUrl = clips[p.session.clipIndex];
        if (!clipUrl) {
          recordFailure(
            p,
            "download",
            new Error(`expected clip ${p.session.clipIndex + 1} of ${p.session.expectedClips}, but Zoom only reported ${clips.length}`)
          );
          continue;
        }

        fs.mkdirSync(p.targetDir, { recursive: true });
        console.log(`Downloading -> ${p.targetPath}`);
        try {
          const savedPath = await downloadToFile(page, clipUrl, p.targetDir, p.fileName);
          state[p.session.stateKey] = { ...state[p.session.stateKey], download: { status: "downloaded", file: savedPath, at: new Date().toISOString() } };
          saveState(config.stateFile, state);
          console.log(`OK    ${savedPath}`);
          counts.downloaded++;
        } catch (err) {
          recordFailure(p, "download", err);
          continue;
        }
        try {
          await runUpload(p);
        } catch (err) {
          recordFailure(p, "upload", err);
        }
      }
    }
  } finally {
    rl.close();
    await browser.close();
  }

  console.log(`SUMMARY: downloaded=${counts.downloaded} uploaded=${counts.uploaded} fail=${counts.fail} skip=${counts.skip} pendingSplit=${counts.pendingSplit}`);
}

// Only fires for a manual invocation -- daily-check.sh sets
// ZOOM_SYNC_SKIP_AUTO_REPORT=1 before running this, because it already
// captures this same output to $SYNC_LOG itself and calls send-report.mjs
// with its own retry-tracking logic (see that file); auto-reporting here
// too would double-email every scheduled run. A --dry-run also skips this --
// it represents no real outcome, so emailing about it would be misleading.
function maybeAutoReport(exitCode) {
  if (DRY_RUN || process.env.ZOOM_SYNC_SKIP_AUTO_REPORT === "1") return;
  const syncLogPath = expandHome("~/.zoom-recordings-sync/last-sync-output.log");
  fs.mkdirSync(path.dirname(syncLogPath), { recursive: true });
  fs.writeFileSync(syncLogPath, logLines.join("\n") + "\n");
  spawnSync("node", [path.join(import.meta.dirname, "send-report.mjs"), String(exitCode), syncLogPath], { stdio: "inherit" });
}

main()
  .then(() => maybeAutoReport(0))
  .catch((err) => {
    console.error(err);
    maybeAutoReport(1);
    process.exit(1);
  });
