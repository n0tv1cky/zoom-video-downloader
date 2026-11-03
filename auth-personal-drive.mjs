#!/usr/bin/env node
// One-time sign-in for the personal Google account recordings are stored on.
//
// Google charges Drive storage to a file's owner, not to the folder it's in,
// and a school account can't hand ownership to a Gmail account. So uploading
// as the school account into a folder the personal account owns would still
// fill the school quota -- the upload has to be made as the personal account.
//
// Uses its own oauth-client-personal.json app, created under the personal
// account because the school app is restricted to its organization
// (403 org_internal). This only adds a second token
// file, alongside the school token (still used to read the recordings sheet).
// Refuses to save anything if the account chosen in the browser is the school
// one, since that would silently bring back the original problem.
//
//   node auth-personal-drive.mjs
import { google } from "googleapis";
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCOPES = ["https://www.googleapis.com/auth/drive"];
const TOKEN_FILE = path.join(os.homedir(), ".zoom-recordings-sync", "personal-drive-token.json");
const CLIENT_FILE = path.join(import.meta.dirname, "oauth-client-personal.json");
const TIMEOUT_MS = 10 * 60 * 1000;

const keys = JSON.parse(fs.readFileSync(CLIENT_FILE, "utf8"));
const key = keys.installed ?? keys.web;
const client = new google.auth.OAuth2(key.client_id, key.client_secret);

function consent() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 10 minutes waiting for the browser sign-in."));
    }, TIMEOUT_MS);
    let redirectUri;
    const finish = (res, message, settle) => {
      res.end(message);
      clearTimeout(timer);
      server.close();
      settle();
    };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) return finish(res, `Sign-in failed: ${error}`, () => reject(new Error(`Google returned an error: ${error}`)));
      if (!code) return res.end();
      try {
        const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
        finish(res, "Sign-in received. You can close this tab and return to Claude.", () => resolve(tokens));
      } catch (err) {
        finish(res, `Sign-in failed: ${err.message}`, () => reject(err));
      }
    });
    server.on("error", reject);
    server.listen(0, "localhost", () => {
      redirectUri = `http://localhost:${server.address().port}`;
      const url = client.generateAuthUrl({
        access_type: "offline",
        prompt: "select_account consent",
        scope: SCOPES,
        redirect_uri: redirectUri,
      });
      console.log("Waiting for sign-in. Choose your PERSONAL Gmail account. If no tab opened, use this link:\n" + url + "\n");
      execFile("open", [url]);
    });
  });
}

const tokens = await consent();
if (!tokens.refresh_token) throw new Error("Google didn't return a refresh token, so nothing was saved.");
client.setCredentials(tokens);

const about = (await google.drive({ version: "v3", auth: client }).about.get({ fields: "user(emailAddress),storageQuota" })).data;
const email = about.user.emailAddress;
if (!email.toLowerCase().endsWith("@gmail.com")) {
  throw new Error(`Signed in as ${email}, which isn't a personal Gmail account. Nothing was saved; run this again and pick the personal account.`);
}

fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
fs.writeFileSync(
  TOKEN_FILE,
  JSON.stringify({ type: "authorized_user", client_id: key.client_id, client_secret: key.client_secret, refresh_token: tokens.refresh_token }),
  { mode: 0o600 }
);
const q = about.storageQuota;
const gb = (b) => (Number(b) / 1e9).toFixed(1);
console.log(`Saved. Signed in as ${email}: ${gb(q.usage)} GB used of ${q.limit ? gb(q.limit) + " GB" : "unlimited"}.`);
