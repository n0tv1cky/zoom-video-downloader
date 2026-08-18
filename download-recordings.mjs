#!/usr/bin/env node
// Downloads Zoom class recordings listed in a Google Sheet, before the share
// links expire. Reused across terms by editing config.json (sheet id/gid,
// column headers, output dir) -- no code changes needed.
//
// Usage:
//   npm install
//   node download-recordings.mjs [--dry-run] [--limit N] [--config path/to/config.json]
//
// The recordings sheet is read via the Google Sheets API using your own
// OAuth login (one-time consent, cached after) -- see config.json's
// "googleOAuth" section. Only the Zoom side needs a real browser; by default
// that drives a separate, dedicated Chrome profile (one-time login, cached
// after) -- see config.json's "chrome" section.

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

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const configIdx = args.indexOf("--config");
const CONFIG_PATH = configIdx !== -1 ? args[configIdx + 1] : new URL("./config.json", import.meta.url).pathname;

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
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
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
// unrecognized code degrades gracefully instead of breaking the run).
function resolveSubjectCode(rawCourseCode, subjectCodeMap) {
  const raw = String(rawCourseCode ?? "").trim();
  const match = raw.match(/^(.*?)\s*\((\d+)\)\s*$/);
  const abbrev = (match ? match[1] : raw).trim();
  const sessionNumber = match ? match[2] : null;
  const subjectCode = subjectCodeMap[abbrev.toUpperCase()] ?? (/^DSM\s*\d+$/i.test(abbrev) ? abbrev.replace(/\s+/g, " ") : abbrev);
  return { subjectCode, sessionNumber, courseCodeWithSession: sessionNumber ? `${subjectCode} (${sessionNumber})` : subjectCode };
}

// One folder per subject, not per session -- e.g. "DSM 107" -> "DSM-107" so
// every ME/DSM-107 recording lands together regardless of session number.
function courseFolder(subjectCode) {
  return slug(subjectCode) || "Uncategorized";
}

async function waitForLogin(page, rl) {
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

async function uploadToDrive(drive, driveConfig, termFolderId, courseFolderName, localPath, fileName) {
  const parentId = driveConfig.organizeByCourse ? await findOrCreateDriveFolder(drive, termFolderId, courseFolderName) : termFolderId;

  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [parentId] },
    media: { mimeType: "video/mp4", body: fs.createReadStream(localPath) },
    fields: "id, webViewLink",
  });
  return res.data;
}

function parseRows(rawRows, columns) {
  return rawRows
    .map((r) => ({
      date: r[columns.date],
      time: r[columns.time],
      courseCode: r[columns.courseCode],
      faculty: r[columns.faculty],
      linkActiveTo: r[columns.linkActiveTo],
      link: r[columns.link],
    }))
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
      { ...row, courseCode: resolved.courseCodeWithSession, subjectCode: resolved.subjectCode, clipIndex: 0, expectedClips: 1, stateKey: row.link },
    ];
  }
  const faculties = splitField(row.faculty);
  return rawCourseCodes.map((rawCourseCode, i) => {
    const resolved = resolveSubjectCode(rawCourseCode, subjectCodeMap);
    return {
      ...row,
      courseCode: resolved.courseCodeWithSession,
      subjectCode: resolved.subjectCode,
      faculty: faculties[i] ?? faculties[faculties.length - 1] ?? row.faculty,
      clipIndex: i,
      expectedClips: rawCourseCodes.length,
      stateKey: `${row.link}#clip${i}`,
    };
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

  const res = await fetch(mp4Url, {
    headers: { Cookie: cookieHeader, Referer: page.url(), "User-Agent": userAgent },
  });
  if (!res.ok || !res.body) throw new Error(`Video download failed: HTTP ${res.status}`);

  const targetPath = path.join(outputDir, fileName);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(targetPath));
  return targetPath;
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
  fs.mkdirSync(config.chromeProfileDir, { recursive: true });
  return puppeteer.launch({
    headless: false,
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
  const rows = parseRows(rawRows, config.columns);
  const sessions = rows.flatMap((row) => expandRowIntoSessions(row, config.subjectCodeMap));
  console.log(
    `Found ${rows.length} row(s) with a recording link` +
      (sessions.length !== rows.length ? ` (${sessions.length} sessions after splitting combined-link rows).` : ".")
  );

  const plan = sessions.map((session) => {
    const fileName = buildFileName(config.fileNameTemplate, session);
    const courseFolderName = courseFolder(session.subjectCode);
    const targetDir = config.organizeByCourse ? path.join(config.outputDir, courseFolderName) : config.outputDir;
    const targetPath = path.join(targetDir, fileName);
    const entry = state[session.stateKey] ?? {};
    const localFileExists = fs.existsSync(targetPath);
    const uploaded = !config.driveUpload.enabled || entry.upload?.status === "uploaded";
    // A session only needs re-fetching from Zoom if we don't have the file
    // locally AND we don't have a durable copy on Drive either. Once
    // uploaded, deleteLocalAfterUpload may have removed the local file on
    // purpose -- that's not "missing," it's "no longer needed."
    const needsDownload = !localFileExists && !uploaded;
    const needsUpload = config.driveUpload.enabled && !uploaded;
    return { session, fileName, courseFolderName, targetDir, targetPath, localFileExists, uploaded, needsDownload, needsUpload };
  });

  for (const p of plan) {
    if (!p.needsDownload && !p.needsUpload) {
      console.log(`SKIP  (${p.localFileExists ? "already done" : "uploaded, local copy removed"}) ${p.fileName}`);
    }
  }

  const pending = plan.filter((p) => p.needsDownload || p.needsUpload).slice(0, LIMIT);
  if (pending.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (DRY_RUN) {
    for (const p of pending) {
      if (p.needsDownload) console.log(`WOULD DOWNLOAD -> ${p.targetPath}`);
      else console.log(`WOULD UPLOAD (already downloaded) -> ${p.targetPath}`);
    }
    return;
  }

  const drive = config.driveUpload.enabled ? google.drive({ version: "v3", auth: authClient }) : null;
  const termFolderId = config.driveUpload.enabled
    ? await findOrCreateDriveFolder(drive, config.driveUpload.rootFolderId, config.driveUpload.termFolderName)
    : null;

  async function runUpload(p) {
    if (!config.driveUpload.enabled || p.uploaded) return;
    console.log(`Uploading -> Drive/${config.driveUpload.termFolderName}/${p.courseFolderName}/${p.fileName}`);
    const uploaded = await uploadToDrive(drive, config.driveUpload, termFolderId, p.courseFolderName, p.targetPath, p.fileName);
    state[p.session.stateKey] = {
      ...state[p.session.stateKey],
      upload: { status: "uploaded", fileId: uploaded.id, webViewLink: uploaded.webViewLink, at: new Date().toISOString() },
    };
    saveState(config.stateFile, state);
    console.log(`OK    ${uploaded.webViewLink}`);

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
  if (toDownload.length === 0) return;

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
