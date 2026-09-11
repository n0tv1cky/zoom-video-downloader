// Builds the daily sync report as HTML instead of plain text -- same visual
// pattern as the sibling calendar-sync project's lib/notify.mjs (card per
// item, colored accent bar, badge section headers), adapted for this
// project's content: uploaded recordings, failures, and recordings pending
// a manual split. All content comes from parsing download-recordings.mjs's
// own log output (see parseLogEntries) plus the SUMMARY line already parsed
// by send-report.mjs -- no new data plumbing needed.

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Pulls structured entries out of download-recordings.mjs's plain-text log:
// - uploaded: pairs an "Uploading -> Drive/<term>/<course>/<file>" line with
//   the "OK    <driveLink>" line immediately after it (the upload
//   confirmation, not the earlier download-step OK for the same file).
// - failed: "FAIL  (<phase>) <file>: <message>" lines, message truncated --
//   some (e.g. an ffmpeg stderr dump) run to hundreds of characters, which
//   would swamp the email; the full text is still in the log file itself.
// - pendingSplit: "SKIP  (pending manual split -- run confirm-split.mjs
//   <stateKey>) <file>" lines.
function parseLogEntries(logText) {
  const uploaded = [...logText.matchAll(/Uploading -> Drive\/[^/\n]*\/([^/\n]+)\/([^\n]+)\nOK\s+(\S+)/g)].map((m) => ({
    course: m[1],
    fileName: m[2],
    driveLink: m[3],
  }));

  const failed = [...logText.matchAll(/^FAIL\s+\(([^)]+)\)\s+([^\n:]+):\s*(.+)$/gm)].map((m) => ({
    phase: m[1],
    fileName: m[2],
    message: m[3].length > 160 ? `${m[3].slice(0, 160)}…` : m[3],
  }));

  const pendingSplit = [...logText.matchAll(/^SKIP\s+\(pending manual split -- run confirm-split\.mjs (\S+)\)\s+(.+)$/gm)].map((m) => ({
    stateKey: m[1],
    fileName: m[2],
  }));

  const facultyWarnings = [...logText.matchAll(/^WARN\s+\(unexpected faculty\)\s+([^\n:]+):\s*(.+)$/gm)].map((m) => ({
    fileName: m[1],
    message: m[2],
  }));

  return { uploaded, failed, pendingSplit, facultyWarnings };
}

function renderCard({ accentColor, title, subtitle, body }) {
  return `
    <tr>
      <td style="padding:0 0 10px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:10px; box-shadow:0 1px 2px rgba(0,0,0,0.06); overflow:hidden;">
          <tr>
            <td width="4" style="background:${accentColor};"></td>
            <td style="padding:14px 16px;">
              <div style="font-size:14px; font-weight:600; color:#1a1a1a;">${escapeHtml(title)}</div>
              ${subtitle ? `<div style="font-size:12.5px; color:#5f6368; margin-top:2px;">${escapeHtml(subtitle)}</div>` : ""}
              ${body ?? ""}
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderSection(title, badgeColor, items, cardHtmlFor) {
  if (items.length === 0) return "";
  return `
    <tr><td style="padding:22px 0 8px 2px;">
      <span style="font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; color:${badgeColor};">${escapeHtml(title)}</span>
      <span style="font-size:11px; color:#9aa0a6; margin-left:6px;">${items.length}</span>
    </td></tr>
    ${items.map(cardHtmlFor).join("")}`;
}

function codeBlock(text) {
  return `<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; background:#f1f3f4; color:#1a1a1a; border-radius:6px; padding:8px 10px; margin-top:8px; overflow-x:auto; white-space:pre;">${escapeHtml(text)}</div>`;
}

// syncExit/hasFailure/isRetry/classification/summary are exactly what
// send-report.mjs already computes (classify()'s result and
// extractSummary()'s parsed SUMMARY line) -- this function only turns them
// into HTML, no new decision logic lives here. hasFailure is NOT the same
// as syncExit !== 0: a per-recording failure is non-fatal in
// download-recordings.mjs (one bad Zoom link doesn't abort the run), so a
// run can finish with exit 0 while summary.fail > 0 (confirmed live
// 2026-08-30) -- headline/subject/retry-note all need to reflect that
// failure even though the process itself "succeeded."
export function buildReportEmail({ term, syncExit, hasFailure, isRetry, summary, classification, logText }) {
  const { uploaded, failed, pendingSplit, facultyWarnings } = parseLogEntries(logText);
  const retryTag = isRetry ? " (retry)" : "";
  const fatalCrash = syncExit !== 0;

  let headline, subheadline;
  if (fatalCrash) {
    headline = `Sync crashed (exit ${syncExit})`;
    subheadline = classification.reason ?? "See failures below and the full log for detail.";
  } else if (uploaded.length === 0 && pendingSplit.length === 0 && failed.length === 0 && facultyWarnings.length === 0) {
    headline = "Nothing new today";
    subheadline = summary ? `Checked ${summary.skip} recording(s) already on Drive -- nothing to do.` : "Run completed with no SUMMARY line (unexpected, but exit code was 0).";
  } else {
    const parts = [];
    if (uploaded.length > 0) parts.push(`${uploaded.length} recording${uploaded.length === 1 ? "" : "s"} uploaded`);
    if (pendingSplit.length > 0) parts.push(`${pendingSplit.length} need${pendingSplit.length === 1 ? "s" : ""} a manual split`);
    if (failed.length > 0) parts.push(`${failed.length} failed`);
    if (facultyWarnings.length > 0) parts.push(`${facultyWarnings.length} unexpected faculty`);
    headline = parts.length > 0 ? parts.join(", ") : "Nothing new today";
    subheadline = classification.reason ?? `Term: ${term}`;
  }

  let subject;
  if (fatalCrash) {
    subject = `Zoom sync CRASHED (exit ${syncExit})${retryTag}`;
  } else {
    const subjectParts = [];
    if (uploaded.length > 0) subjectParts.push(`${uploaded.length} uploaded`);
    if (pendingSplit.length > 0) subjectParts.push(`${pendingSplit.length} needs manual split`);
    if (failed.length > 0) subjectParts.push(`${failed.length} failed`);
    if (facultyWarnings.length > 0) subjectParts.push(`${facultyWarnings.length} unexpected faculty`);
    if (subjectParts.length === 0) subjectParts.push("nothing new today");
    subject = `Zoom sync: ${subjectParts.join(", ")}${retryTag}`;
  }

  const uploadedSection = renderSection("Uploaded", "#188038", uploaded, (u) =>
    renderCard({
      accentColor: "#34a853",
      title: u.fileName,
      subtitle: u.course,
      body: `<div style="margin-top:8px;"><a href="${u.driveLink}" style="font-size:12.5px; color:#1a73e8; text-decoration:none;">View on Drive →</a></div>`,
    })
  );

  const pendingSection = renderSection("Needs manual split", "#e37400", pendingSplit, (p) =>
    renderCard({
      accentColor: "#fbbc04",
      title: p.fileName,
      subtitle: "No confident silence gap found in the expected window",
      body: codeBlock(`node confirm-split.mjs "${p.stateKey}" --at MM:SS`),
    })
  );

  const failedSection = renderSection("Failed", "#c5221f", failed, (f) =>
    renderCard({
      accentColor: "#ea4335",
      title: f.fileName,
      subtitle: `Phase: ${f.phase}`,
      body: `<div style="font-size:12.5px; color:#5f6368; margin-top:6px;">${escapeHtml(f.message)}</div>`,
    })
  );

  const facultyWarningSection = renderSection("Unexpected faculty", "#b06000", facultyWarnings, (w) =>
    renderCard({
      accentColor: "#f9ab00",
      title: w.fileName,
      subtitle: "Doesn't match the course's known instructor list -- check the recordings sheet's Faculty column",
      body: `<div style="font-size:12.5px; color:#5f6368; margin-top:6px;">${escapeHtml(w.message)}</div>`,
    })
  );

  const retryNote = hasFailure
    ? `<div style="font-size:11.5px; color:#9aa0a6; padding-top:14px;">${classification.retry ? "A same-day retry has been queued." : "No same-day retry queued -- this needs a manual fix."}</div>`
    : "";

  const html = `
<div style="background:#f4f5f7; padding:32px 16px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px; margin:0 auto;">
    <tr>
      <td style="padding-bottom:18px;">
        <div style="font-size:13px; color:#5f6368; font-weight:600; letter-spacing:0.02em;">🎥 ZOOM RECORDINGS SYNC</div>
        <div style="font-size:20px; font-weight:700; color:#1a1a1a; margin-top:4px;">${escapeHtml(headline)}</div>
        <div style="font-size:13px; color:#5f6368; margin-top:4px;">${escapeHtml(subheadline)}</div>
      </td>
    </tr>
    ${uploadedSection}
    ${pendingSection}
    ${failedSection}
    ${facultyWarningSection}
    <tr>
      <td style="padding-top:28px; border-top:1px solid #e8eaed; margin-top:12px;">
        ${retryNote}
        <div style="font-size:11.5px; color:#9aa0a6; padding-top:14px;">Sent automatically after each daily sync run. Full log: ~/.zoom-recordings-sync/last-sync-output.log</div>
      </td>
    </tr>
  </table>
</div>`;

  return { subject, html };
}
