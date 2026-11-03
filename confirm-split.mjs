#!/usr/bin/env node
// Finishes a continuous-recording split that download-recordings.mjs
// couldn't confidently do automatically (no clean silence gap found inside
// the schedule-derived search window for at least one boundary -- see
// docs/continuous-recording-splitting.md). Only needed for that ambiguous
// case; the common case (a real inter-class gap was found) already
// splits+uploads fully automatically with no human step.
//
// Usage:
//   node confirm-split.mjs <stateKey> --at 62:30
//   node confirm-split.mjs <stateKey> --at 32:10,95:48   (N-1 cut points for N sessions)
//
// <stateKey> is any one of the sessions in the group (their state entries
// all point at the same rawFile/groupStateKeys -- see download-recordings.mjs's
// pending-manual-split write). Find it from the daily report email or by
// grepping the state file for "pending-manual-split".
//
// Deliberately refuses to run without --at: this is exactly the case where
// an automatic guess wasn't good enough, so there is no sensible default
// timestamp to fall back to -- open the raw file locally (QuickTime or
// similar), find the real cut(s) by eye/ear, and pass them explicitly.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { google } from "googleapis";
import { mergeLocalConfig } from "./lib/configLocal.mjs";
import { splitByCutPoints } from "./lib/continuousSplit.mjs";

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function resolveConfigPath(configDir, p) {
  const expanded = expandHome(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
}

function loadConfig() {
  const configPath = new URL("./config.json", import.meta.url).pathname;
  const configDir = path.dirname(configPath);
  const raw = mergeLocalConfig(configDir, JSON.parse(fs.readFileSync(configPath, "utf8")));
  raw.stateFile = expandHome(raw.stateFile);
  raw.googleOAuth = raw.googleOAuth ?? {};
  raw.googleOAuth.clientSecretFile = resolveConfigPath(configDir, raw.googleOAuth.clientSecretFile || "./oauth-client.json");
  raw.googleOAuth.tokenFile = expandHome(raw.googleOAuth.tokenFile || "~/.zoom-recordings-sync/google-oauth-token.json");
  raw.driveUpload = raw.driveUpload ?? {};
  raw.driveUpload.enabled = raw.driveUpload.enabled ?? false;
  raw.driveUpload.organizeByCourse = raw.driveUpload.organizeByCourse ?? true;
  raw.driveUpload.termFolderName = raw.driveUpload.termFolderName || path.basename(raw.outputDir ?? "");
  raw.driveUpload.tokenFile = expandHome(raw.driveUpload.tokenFile || raw.googleOAuth.tokenFile);
  return raw;
}

// MM:SS, H:MM:SS, or a bare number of seconds -> seconds.
function parseTimestamp(s) {
  const parts = s.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) throw new Error(`Not a valid timestamp: "${s}" (use MM:SS, H:MM:SS, or seconds)`);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
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
  const created = await drive.files.create({ requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }, fields: "id" });
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

async function main() {
  const [stateKey, ...rest] = process.argv.slice(2);
  const atIdx = rest.indexOf("--at");
  if (!stateKey || atIdx === -1 || !rest[atIdx + 1]) {
    console.error("Usage: node confirm-split.mjs <stateKey> --at MM:SS[,MM:SS,...]");
    process.exit(1);
  }
  const cutSeconds = rest[atIdx + 1].split(",").map((s) => parseTimestamp(s.trim()));

  const config = loadConfig();
  const state = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
  const entry = state[stateKey];
  if (entry?.download?.status !== "pending-manual-split") {
    console.error(`"${stateKey}" is not currently pending-manual-split in ${config.stateFile}. Nothing to do.`);
    process.exit(1);
  }

  const { rawFile, groupStateKeys, targetPaths, fileNames, courseFolderNames } = entry.download;
  if (cutSeconds.length !== targetPaths.length - 1) {
    console.error(`This group has ${targetPaths.length} sessions (needs ${targetPaths.length - 1} cut point(s)), but --at gave ${cutSeconds.length}.`);
    process.exit(1);
  }
  if (!fs.existsSync(rawFile)) {
    console.error(`Raw file no longer exists at ${rawFile} -- was it already cleaned up? Check whether this was already resolved.`);
    process.exit(1);
  }

  for (const p of targetPaths) fs.mkdirSync(path.dirname(p), { recursive: true });
  console.log(`Splitting ${rawFile} at ${cutSeconds.join("s, ")}s (manually confirmed)...`);
  splitByCutPoints(rawFile, cutSeconds, targetPaths);

  for (let i = 0; i < groupStateKeys.length; i++) {
    state[groupStateKeys[i]] = { ...state[groupStateKeys[i]], download: { status: "downloaded", file: targetPaths[i], splitFrom: path.basename(rawFile), confirmedManually: true, at: new Date().toISOString() } };
    console.log(`OK    ${targetPaths[i]}`);
  }
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));

  if (!config.driveUpload.enabled) {
    console.log("driveUpload.enabled is false -- leaving split files local, not uploading.");
    return;
  }

  const authClient = google.auth.fromJSON(JSON.parse(fs.readFileSync(config.driveUpload.tokenFile, "utf8")));
  const drive = google.drive({ version: "v3", auth: authClient });
  const termFolderId = config.driveUpload.rootFolderId
    ? await findOrCreateDriveFolder(drive, config.driveUpload.rootFolderId, config.driveUpload.termFolderName)
    : null;

  for (let i = 0; i < groupStateKeys.length; i++) {
    const key = groupStateKeys[i];
    const priorUpload = state[key]?.upload;
    console.log(`Uploading -> Drive/${config.driveUpload.termFolderName}/${courseFolderNames[i]}/${fileNames[i]}`);
    const uploaded = await uploadToDrive(drive, config.driveUpload, termFolderId, courseFolderNames[i], targetPaths[i], fileNames[i]);
    state[key] = { ...state[key], upload: { status: "uploaded", fileId: uploaded.id, webViewLink: uploaded.webViewLink, at: new Date().toISOString() } };
    fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
    console.log(`OK    ${uploaded.webViewLink}`);

    if (priorUpload?.status === "uploaded" && priorUpload.fileId && priorUpload.fileId !== uploaded.id) {
      try {
        await drive.files.delete({ fileId: priorUpload.fileId });
        console.log(`Removed previous (incorrect, full-length) upload: ${priorUpload.fileId}`);
      } catch (err) {
        console.error(`WARN: failed to delete stale upload ${priorUpload.fileId}: ${err.message}`);
      }
    }

    if (config.driveUpload.deleteLocalAfterUpload) {
      fs.rmSync(targetPaths[i], { force: true });
      console.log(`Removed local copy (kept on Drive): ${targetPaths[i]}`);
    }
  }

  // Only remove the shared raw file once every session's upload above has
  // actually succeeded (we're past all the throws by this point) -- never
  // as a side effect of merely attempting one.
  fs.rmSync(rawFile, { force: true });
  console.log(`Removed raw file: ${rawFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
