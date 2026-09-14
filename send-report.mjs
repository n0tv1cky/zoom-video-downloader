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
import { buildReportEmail } from "./lib/notify.mjs";

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

// hasFailure, not syncExit -- download-recordings.mjs only exits non-zero
// on a *fatal* crash (main().catch). A per-recording failure (recordFailure)
// is non-fatal by design (one bad Zoom link shouldn't abort the whole run),
// so a run can legitimately finish with exit 0 while still having failed
// sessions (confirmed live 2026-08-30: a Navigation timeout on one
// combined-link group, exit 0 overall, 2 other recordings uploaded fine in
// the same run). Gating retry on syncExit alone silently skipped same-day
// retry for exactly the kind of transient failure it exists to catch.
function classify(logText, hasFailure) {
  if (!hasFailure) return { retry: false, reason: null };
  for (const { re, reason } of NON_TRANSIENT_PATTERNS) {
    if (re.test(logText)) return { retry: false, reason };
  }
  return { retry: true, reason: null };
}

function extractSummary(logText) {
  const matches = [...logText.matchAll(/^SUMMARY: downloaded=(\d+) uploaded=(\d+) fail=(\d+) skip=(\d+) pendingSplit=(\d+)$/gm)];
  if (matches.length === 0) return null;
  const [, downloaded, uploaded, fail, skip, pendingSplit] = matches.at(-1);
  return { downloaded: +downloaded, uploaded: +uploaded, fail: +fail, skip: +skip, pendingSplit: +pendingSplit };
}

function buildRawMessage({ to, from, subject, html }) {
  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?utf-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
  ];
  return Buffer.from(messageParts.join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A "nothing new today" report at every single scheduled slot is real
// inbox clutter (confirmed live 2026-09-14 -- a run every 4h with nothing
// to do most of the time produced 5+ identical emails in one day, see the
// screenshot that prompted this). Anything actually worth knowing about
// (an upload, a failure, a pending-manual-split, an unexpected-faculty
// flag) still emails every time, same as before -- this only suppresses
// the empty case, and only for runs that aren't the last scheduled slot of
// the day, so there's still always at least one email confirming the day's
// final state even on a fully uneventful day.
function isLastScheduledRunOfDay(config, now = new Date()) {
  const { intervalHours, activeHours } = config.schedule ?? {};
  if (!intervalHours || !activeHours) return true; // no schedule config to compare against -- default to always sending
  const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  const startMin = toMinutes(activeHours.start);
  const endMin = toMinutes(activeHours.end);
  const stepMin = intervalHours * 60;
  let lastSlotMin = startMin;
  for (let t = startMin; t <= endMin; t += stepMin) lastSlotMin = t;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= lastSlotMin - 5; // small grace for cron jitter; also naturally covers a same-evening retry after the last slot
}

async function main() {
  const [syncExitArg, logPathArg, ...rest] = process.argv.slice(2);
  const syncExit = parseInt(syncExitArg, 10);
  const isRetry = rest.includes("--retry");
  const logText = fs.readFileSync(logPathArg, "utf8");

  const config = loadConfig();
  const summary = extractSummary(logText);
  const hasFailure = syncExit !== 0 || (summary?.fail ?? 0) > 0;
  const classification = classify(logText, hasFailure);
  const { subject, html } = buildReportEmail({ term: config.term, syncExit, hasFailure, isRetry, summary, classification, logText });

  const nothingToReport = /nothing new today/i.test(subject);
  if (nothingToReport && !isLastScheduledRunOfDay(config)) {
    console.error(`Report suppressed (${subject}, not the last scheduled run of the day -- config.schedule.activeHours.end)`);
  } else {
    try {
      const authClient = await getGmailAuthClient(config.googleOAuth.clientSecretFile, expandHome(config.notifications.tokenFile));
      const gmail = google.gmail({ version: "v1", auth: authClient });
      const to = [config.notifications.toEmail, ...(config.notifications.additionalRecipients ?? [])].join(", ");
      const raw = buildRawMessage({
        to,
        from: config.notifications.toEmail, // Gmail send-only token can only send as its own account
        subject,
        html,
      });
      await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      console.error(`Report emailed: ${subject}`);
    } catch (err) {
      // A failed notification must not itself block the retry decision below --
      // the sync's own outcome matters more than whether the email about it
      // went out.
      console.error(`WARN: failed to send report email: ${err.message}`);
    }
  }

  console.log(hasFailure && classification.retry ? "RETRY" : "NO-RETRY");
}

main().catch((err) => {
  console.error(err);
  console.log("RETRY"); // fail-open: an error in this script itself shouldn't suppress a real retry
  process.exit(1);
});
