/**
 * ingestJson.js — normalize events.json into the standard event shape.
 *
 * Nothing outside src/ingest/ should read events.json directly.
 */

const fs = require("fs");
const path = require("path");
const { isGuestSuppliedContent, containsSuspiciousQuotedInstruction, classifySegment } = require("./classify");

const DATA_FILE = path.resolve(__dirname, "../../data/events.json");
const SOURCE_FILE = "data/events.json";

// Map structured event types to canonical categories.
// Types not listed here fall through to the classifier (or "unknown").
const TYPE_TO_CATEGORY = {
  check_in:               "check_in",
  check_in_issue:         "check_in",
  maintenance:            "maintenance",
  compliance:             "compliance",
  complaint:              "complaint",
  lost_keycard:           "note",
  deposit_issue:          "finance",
  facilities:             "facilities",
  no_show:                "finance",
  walk_in:                "note",
  finance_note:           "finance",
  incident:               "incident",
  early_checkout_request: "note",
  damage_report:          "finance",
  note:                   "note",
  guest_message:          "guest_message", // firewall: description is display-only
};

/**
 * A night shift runs 23:00–07:00 and "belongs to" the morning date.
 * Events at 23:xx on date D are part of the shift that ends on D+1.
 * Events at 00:xx–22:xx on date D belong to that same D.
 */
function shiftDateFromTimestamp(isoTimestamp) {
  const d = new Date(isoTimestamp);
  if (d.getHours() >= 23) {
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    return next.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

function normalizeEvent(raw, hotelId) {
  const category = TYPE_TO_CATEGORY[raw.type] ?? "unknown";
  const shiftDate = shiftDateFromTimestamp(raw.timestamp);
  const sourceRef = { file: SOURCE_FILE, recordId: raw.id };

  // FIREWALL: guest_message (and any other guest-supplied type) gets its
  // status directly from the source record. Description text is never passed
  // to the classifier — it is display-only data, not operational signal.
  if (isGuestSuppliedContent(raw.type)) {
    // Read-only audit scan: does not change status, category, or routing.
    // guest_supplied_content already blocks classifySegment() and routes to review.
    // This only adds a second flag for audit visibility if the payload matches.
    const guestFlags = ["guest_supplied_content"];
    const suspicion = containsSuspiciousQuotedInstruction(raw.description);
    if (suspicion.suspicious) {
      guestFlags.push("suspicious_instruction_pattern");
      guestFlags.push(`suspicious_word:${suspicion.matchedWord}`);
    }
    return {
      id: raw.id,
      hotelId,
      shiftDate,
      timestamp: raw.timestamp,
      room: raw.room ?? null,
      category,
      status: raw.status ?? "unknown",
      description: raw.description,
      sourceRef,
      flags: guestFlags,
    };
  }

  // For operational events: trust the structured status field when present
  // and not obviously a placeholder; fall back to classifier only if absent.
  const structuredStatus = raw.status && raw.status !== "" ? raw.status : null;
  const status = structuredStatus ?? classifySegment(raw.description).status;

  // Independent second signal: quoted/reported-speech spans with imperative
  // language get flagged for human review regardless of category/status.
  // Does NOT change status or suppress anything — review only.
  const flags = [];
  const suspicion = containsSuspiciousQuotedInstruction(raw.description);
  if (suspicion.suspicious) {
    flags.push("suspicious_instruction_pattern");
    flags.push(`suspicious_word:${suspicion.matchedWord}`);
  }

  return {
    id: raw.id,
    hotelId,
    shiftDate,
    timestamp: raw.timestamp,
    room: raw.room ?? null,
    category,
    status,
    description: raw.description,
    sourceRef,
    flags,
  };
}

function loadJsonEvents(hotelId) {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  return raw.events.map((evt) => normalizeEvent(evt, hotelId));
}

module.exports = { loadJsonEvents };
