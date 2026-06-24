/**
 * renderHtml.js — render a handover JSON object as an HTML page.
 *
 * Every displayed string comes from the handover JSON, which is already
 * sourceRef-backed. No new prose is composed here.
 */

const BUCKET_META = {
  urgent:   { label: "Urgent — action required",        color: "#c0392b", bg: "#fdf2f2" },
  pending:  { label: "Pending — morning team to decide", color: "#d35400", bg: "#fef9f2" },
  resolved: { label: "Resolved overnight",               color: "#27ae60", bg: "#f2fdf5" },
  flagged:  { label: "Flagged — needs human review",     color: "#7f8c8d", bg: "#f7f8f8" },
};

const CATEGORY_LABEL = {
  compliance:    "Compliance",
  maintenance:   "Maintenance",
  finance:       "Finance",
  facilities:    "Facilities",
  complaint:     "Complaint",
  incident:      "Incident",
  check_in:      "Check-in",
  note:          "Note",
  guest_message: "Guest message",
  unknown:       "Unknown",
};

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sourceRefLabel(ref) {
  if (!ref) return "";
  if (ref.recordId) return `${esc(ref.file)} · ${esc(ref.recordId)}`;
  return `${esc(ref.file)} · line ${ref.lineNumber}`;
}

function renderItem(item) {
  const room = item.room ? `<span class="room">Room ${esc(item.room)}</span> ` : "";
  const cat  = `<span class="cat">${esc(CATEGORY_LABEL[item.category] ?? item.category)}</span>`;
  const span = item.spanNote ? `<div class="span-note">${esc(item.spanNote)}</div>` : "";
  const flagReason = item.flagReason
    ? `<div class="flag-reason">Flag reason: ${esc(item.flagReason)}</div>` : "";
  const eventFlags = item.flags.filter(f => !f.startsWith("suspicious_word"));
  const flagBadges = eventFlags.length
    ? `<div class="badges">${eventFlags.map(f => `<span class="badge">${esc(f)}</span>`).join(" ")}</div>`
    : "";

  // Show all sourceRefs for multi-event threads
  const refList = item.sourceRefs.map(r =>
    `<span class="source-ref">${sourceRefLabel(r)}</span>`
  ).join(" ");

  return `
    <div class="item">
      <div class="item-header">${room}${cat}</div>
      <div class="summary">${esc(item.summary)}</div>
      ${span}${flagReason}${flagBadges}
      <div class="source-refs">Source: ${refList}</div>
    </div>`;
}

function renderBucket(key, items) {
  if (!items.length) return "";
  const meta = BUCKET_META[key];
  const renderedItems = items.map(renderItem).join("\n");
  return `
  <section class="bucket" style="border-left: 4px solid ${meta.color}; background: ${meta.bg};">
    <h2 style="color:${meta.color}">${esc(meta.label)} <span class="count">(${items.length})</span></h2>
    ${renderedItems}
  </section>`;
}

function renderHtml(handover) {
  const { hotelId, shiftDate, generatedAt, counts } = handover;

  const summary = `
    <div class="summary-bar">
      <span class="s-urgent">🔴 ${counts.urgent} urgent</span>
      <span class="s-pending">🟠 ${counts.pending} pending</span>
      <span class="s-resolved">🟢 ${counts.resolved} resolved</span>
      <span class="s-flagged">⚪ ${counts.flagged} flagged</span>
    </div>`;

  const sections = ["urgent", "pending", "resolved", "flagged"]
    .map((k) => renderBucket(k, handover[k]))
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Night Handover — ${esc(hotelId)} — ${esc(shiftDate)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 860px; margin: 0 auto; padding: 24px; color: #2c3e50; }
    h1 { font-size: 1.4rem; margin-bottom: 4px; }
    .meta { color: #7f8c8d; font-size: 0.85rem; margin-bottom: 20px; }
    .summary-bar { display: flex; gap: 20px; padding: 12px 16px; background: #f0f0f0; border-radius: 6px; margin-bottom: 24px; font-weight: 600; }
    .bucket { padding: 16px 20px; border-radius: 6px; margin-bottom: 20px; }
    .bucket h2 { margin: 0 0 12px; font-size: 1rem; }
    .count { font-weight: 400; font-size: 0.9rem; }
    .item { padding: 10px 0; border-top: 1px solid rgba(0,0,0,0.08); }
    .item:first-of-type { border-top: none; }
    .item-header { font-size: 0.8rem; margin-bottom: 4px; }
    .room { font-weight: 700; }
    .cat { background: #ecf0f1; padding: 1px 6px; border-radius: 3px; font-size: 0.75rem; }
    .summary { font-size: 0.95rem; line-height: 1.5; margin-bottom: 4px; }
    .span-note { font-size: 0.78rem; color: #7f8c8d; margin-bottom: 2px; }
    .flag-reason { font-size: 0.78rem; color: #e67e22; margin-bottom: 2px; }
    .badges { margin-bottom: 4px; }
    .badge { font-size: 0.72rem; background: #ecf0f1; padding: 1px 5px; border-radius: 3px; margin-right: 4px; }
    .source-refs { font-size: 0.72rem; color: #95a5a6; }
    .source-ref { margin-right: 8px; }
  </style>
</head>
<body>
  <h1>Night Handover — ${esc(hotelId)}</h1>
  <div class="meta">Shift date: ${esc(shiftDate)} &nbsp;·&nbsp; Generated: ${esc(generatedAt)}</div>
  ${summary}
  ${sections}
</body>
</html>`;
}

module.exports = { renderHtml };
