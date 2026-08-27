// Reads the already-finished sync log from daily-check.sh, deterministically
// classifies the outcome, emails a report, and prints exactly one line to
// stdout -- "RETRY" or "NO-RETRY" -- for daily-check.sh to gate the same-day
// retry flag on.
//
// This replaces an earlier design where a `claude -p` call read the log and
// did this classification via LLM judgment. That's gone now: everything this
// script does is pattern-matching against a small, known, closed set of
// error strings that download-recordings.mjs itself throws (see the
// NON_TRANSIENT_PATTERNS list below) -- there was never actually a case here
// that needed real judgment rather than "does this log contain string X",
// and removing the LLM call also removes its cost, latency, and the
// tool-call-timeout failure mode documented in daily-check.sh's history.
//
// Usage: node send-report.mjs <syncExitCode> <logPath> [--retry]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { google } from "googleapis";
import { getGmailAuthClient } from "./lib/gmailAuth.mjs";
import { mergeLocalConfig } from "./lib/configLocal.mjs";

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// clientSecretFile is resolved against the config file's own directory (not
// process.cwd()) so this works the same whether it's run from this folder
// or, as daily-check.sh does, via an absolute script path from elsewhere --
// confirmed live: a real daily-check.sh run failed with ENOENT on
// "./oauth-client.json" because its CWD wasn't this directory.
function loadConfig() {
  const configDir = import.meta.dirname;
  const raw = mergeLocalConfig(configDir, JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8")));
  const clientSecretFile = raw.googleOAuth.clientSecretFile;
  raw.googleOAuth.clientSecretFile = path.isAbsolute(clientSecretFile) ? clientSecretFile : path.resolve(configDir, clientSecretFile);
  return raw;
}

// Known-non-transient error signatures -- each one is a real message
// download-recordings.mjs (or its Chrome-profile-sync helper) actually
// throws today, not a speculative guess. Anything NOT matching one of these
// is treated as possibly transient and defaults to retrying (fail-open: an
// unneeded retry costs a few cents and 15 minutes, wrongly suppressing a
// real one costs a full missed day -- see daily-check.sh's own comments).
const NON_TRANSIENT_PATTERNS = [
  { re: /asking to sign in.*Re-run with --headed/is, reason: "Zoom/Google session expired -- needs an interactive --headed re-login" },
  { re: /invalid_grant|unauthorized_client/i, reason: "Google OAuth refresh token was revoked or expired -- needs re-login" },
  { re: /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i, reason: "Google OAuth token is missing a required scope" },
  { re: /Failed to sync Chrome "Local State"|Failed to sync Chrome profile/i, reason: "Chrome profile sync failed -- needs manual fix, see config.json chrome settings" },
  { re: /ENOENT.*oauth-client\.json/i, reason: "oauth-client.json is missing" },
  { re: /Cannot find module/i, reason: "a required module is missing -- code/dependency problem, not transient" },
];

function classify(logText, syncExit) {
  if (syncExit === 0) return { retry: false, reason: null };
  for (const { re, reason } of NON_TRANSIENT_PATTERNS) {
    if (re.test(logText)) return { retry: false, reason };
  }
  return { retry: true, reason: null };
}

function extractSummary(logText) {
  const matches = [...logText.matchAll(/^SUMMARY: downloaded=(\d+) uploaded=(\d+) fail=(\d+) skip=(\d+)$/gm)];
  if (matches.length === 0) return null;
  const [, downloaded, uploaded, fail, skip] = matches.at(-1);
  return { downloaded: +downloaded, uploaded: +uploaded, fail: +fail, skip: +skip };
}

// The most likely useful lines when there's no SUMMARY line at all (a fatal,
// uncaught error killed the run before reaching one) -- last handful of
// lines, which is where main().catch's console.error(err) stack trace lands.
function tail(logText, n) {
  const lines = logText.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

function buildReport({ syncExit, logText, isRetry, classification }) {
  const summary = extractSummary(logText);
  const retryTag = isRetry ? " (retry)" : "";

  if (syncExit === 0) {
    if (!summary || (summary.downloaded === 0 && summary.uploaded === 0)) {
      return { subject: `Zoom sync: nothing new today${retryTag}`, bodyLines: [summary ? "Nothing to download or upload." : "Run completed with no SUMMARY line (unexpected, but exit code was 0)."] };
    }
    const parts = [];
    if (summary.downloaded > 0) parts.push(`${summary.downloaded} downloaded`);
    if (summary.uploaded > 0) parts.push(`${summary.uploaded} uploaded`);
    return {
      subject: `Zoom sync: ${parts.join(", ")}${retryTag}`,
      bodyLines: [`downloaded=${summary.downloaded} uploaded=${summary.uploaded} fail=${summary.fail} skip=${summary.skip}`],
    };
  }

  const failLines = [...logText.matchAll(/^FAIL.*$/gm)].map((m) => m[0]);
  const bodyLines = [];
  if (classification.reason) bodyLines.push(`Diagnosis: ${classification.reason}`);
  if (summary) bodyLines.push(`downloaded=${summary.downloaded} uploaded=${summary.uploaded} fail=${summary.fail} skip=${summary.skip}`);
  if (failLines.length > 0) {
    bodyLines.push("", "Failures:", ...failLines.slice(0, 10));
  } else {
    bodyLines.push("", "No SUMMARY/FAIL lines found -- run likely crashed before completing. Last lines of the log:", "", tail(logText, 25));
  }
  bodyLines.push("", classification.retry ? "A same-day retry has been queued." : "No same-day retry queued -- this needs a manual fix.");

  return { subject: `Zoom sync FAILED (exit ${syncExit})${retryTag}`, bodyLines };
}

function buildRawMessage({ to, from, subject, text }) {
  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?utf-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ];
  return Buffer.from(messageParts.join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function main() {
  const [syncExitArg, logPathArg, ...rest] = process.argv.slice(2);
  const syncExit = parseInt(syncExitArg, 10);
  const isRetry = rest.includes("--retry");
  const logText = fs.readFileSync(logPathArg, "utf8");

  const config = loadConfig();
  const classification = classify(logText, syncExit);
  const { subject, bodyLines } = buildReport({ syncExit, logText, isRetry, classification });

  try {
    const authClient = await getGmailAuthClient(config.googleOAuth.clientSecretFile, expandHome(config.notifications.tokenFile));
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const raw = buildRawMessage({
      to: config.notifications.toEmail,
      from: config.notifications.toEmail,
      subject,
      text: bodyLines.join("\n"),
    });
    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    console.error(`Report emailed: ${subject}`);
  } catch (err) {
    // A failed notification must not itself block the retry decision below --
    // the sync's own outcome matters more than whether the email about it
    // went out.
    console.error(`WARN: failed to send report email: ${err.message}`);
  }

  console.log(syncExit !== 0 && classification.retry ? "RETRY" : "NO-RETRY");
}

main().catch((err) => {
  console.error(err);
  console.log("RETRY"); // fail-open: an error in this script itself shouldn't suppress a real retry
  process.exit(1);
});
