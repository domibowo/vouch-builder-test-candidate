/**
 * ingestMarkdown.js — parse night-logs.md into the standard event shape.
 *
 * Rule-based only. Each bullet or standalone sentence becomes one event.
 * Non-English segments are flagged; the classifier still runs on whatever
 * English keywords are present, but confidence will be "low".
 *
 * LLM SEAM: the call to classifySegment() in parseSegments() is the exact
 * point to replace with a model call. See classify.js for the contract.
 *
 * Nothing outside src/ingest/ should read night-logs.md directly.
 */

const fs = require("fs");
const path = require("path");
const { classifySegment, isLikelyNonEnglish, detectGuestMessageMarker, containsSuspiciousQuotedInstruction } = require("./classify");

const DATA_FILE = path.resolve(__dirname, "../../data/night-logs.md");
const SOURCE_FILE = "data/night-logs.md";

// Matches: "## Night of Wed 27 May → morning Thu 28 May ..."
// Captures the morning (handover) date as the shift date.
const SHIFT_HEADER_RE = /^##\s+Night of .+?→\s*morning\s+\w+\s+(\d+)\s+(\w+)/i;

const MONTH_MAP = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function parseShiftDate(headerLine) {
  const m = headerLine.match(SHIFT_HEADER_RE);
  if (!m) return null;
  const day = m[1].padStart(2, "0");
  const month = MONTH_MAP[m[2].toLowerCase().slice(0, 3)];
  // Year is not in the header — infer from current context (events.json uses 2026)
  return month ? `2026-${month}-${day}` : null;
}

// Keywords whose presence in a short segment signals it's a real incident
// rather than structural prose, even if it looks like a greeting/sign-off.
const INCIDENT_SIGNAL_WORDS = [
  // room reference
  /\broom\s*\d{2,3}\b/i,
  // action verbs that appear in incident reports
  /\b(check(?:ed)?[- ]in|check(?:ed)?[- ]out|reported|called|complaint|noise|deposit|passport|aircon|leak|safe|wifi|scanner|maintenance|repair|incident|refund|invoice|charge|arrival|keycard)\b/i,
];

/**
 * Returns true if a segment is structural prose (greeting, sign-off, filler)
 * that should not become an event. Filters are conservative: a segment is
 * only dropped if it is short AND has no incident-signal words. A terse but
 * real incident line will typically contain at least one signal word.
 */
function isStructuralProse(text) {
  // Long segments are almost certainly real content — don't filter them
  if (text.length > 80) return false;
  // If any incident-signal word is present, keep it regardless of length
  if (INCIDENT_SIGNAL_WORDS.some((re) => re.test(text))) return false;
  // Short, signal-free: treat as structural (greeting / filler / sign-off)
  return true;
}

/**
 * Split a prose block into segments: each bullet point or sentence.
 * Structural prose lines (greetings, fillers, sign-offs) are dropped here
 * rather than passed downstream as spurious events.
 * Returns [{ text, lineNumber }].
 */
function splitIntoSegments(lines, startLine) {
  const segments = [];
  let i = 0;
  for (const line of lines) {
    const lineNumber = startLine + i;
    i++;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(">") || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("-")) {
      // Bullet point: treat as one segment
      const text = trimmed.slice(1).trim();
      if (!isStructuralProse(text)) segments.push({ text, lineNumber });
    } else {
      // Prose: split on sentence boundaries (naive but sufficient for rule-based)
      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        const text = s.trim();
        if (text.length > 10 && !isStructuralProse(text)) {
          segments.push({ text, lineNumber });
        }
      }
    }
  }
  return segments;
}

function segmentToEvent(seg, hotelId, shiftDate, segIndex) {
  const { text, lineNumber } = seg;
  const sourceRef = { file: SOURCE_FILE, lineNumber };
  const flags = [];

  // FIREWALL: if the staffer prefixed this segment with a guest-message marker
  // (e.g. "Guest message: ..."), treat it identically to a JSON guest_message
  // event — status defaults to "pending", description is verbatim display data,
  // and the text is NEVER passed to classifySegment().
  const { isGuest, strippedText } = detectGuestMessageMarker(text);
  if (isGuest) {
    return {
      id: `log-${shiftDate}-${String(segIndex).padStart(3, "0")}`,
      hotelId,
      shiftDate,
      timestamp: null,
      room: null,
      category: "guest_message",
      status: "pending",
      description: strippedText || text,
      sourceRef,
      flags: ["guest_supplied_content"],
    };
  }

  const nonEnglish = isLikelyNonEnglish(text);
  if (nonEnglish) flags.push("non_english");

  // LLM SEAM: replace classifySegment() with a model call here.
  // Contract: (text) => { category, status, confidence }
  const { category, status, confidence } = classifySegment(text);

  if (confidence === "low") flags.push("low_confidence");

  // Independent second signal: scan for imperative/authorization language
  // inside quoted or reported-speech spans. Does NOT suppress classification —
  // only adds a flag and routes to review. Never auto-approves anything.
  const suspicion = containsSuspiciousQuotedInstruction(text);
  if (suspicion.suspicious) {
    flags.push("suspicious_instruction_pattern");
    flags.push(`suspicious_word:${suspicion.matchedWord}`);
  }

  return {
    id: `log-${shiftDate}-${String(segIndex).padStart(3, "0")}`,
    hotelId,
    shiftDate,
    timestamp: null, // free text rarely has an exact timestamp
    room: null,       // free-text logs don't have a structured room field
    category,
    status,
    description: text,
    sourceRef,
    flags,
  };
}

function loadMarkdownEvents(hotelId) {
  const content = fs.readFileSync(DATA_FILE, "utf8");
  const rawLines = content.split("\n");
  const events = [];

  let currentShiftDate = null;
  let currentBlockLines = [];
  let currentBlockStart = 0;
  let segIndexBase = 0;

  function flushBlock() {
    if (!currentShiftDate || currentBlockLines.length === 0) return;
    const segments = splitIntoSegments(currentBlockLines, currentBlockStart);
    segments.forEach((seg, i) => {
      events.push(segmentToEvent(seg, hotelId, currentShiftDate, segIndexBase + i));
    });
    segIndexBase += segments.length;
  }

  rawLines.forEach((line, idx) => {
    if (line.startsWith("## ")) {
      flushBlock();
      currentShiftDate = parseShiftDate(line);
      currentBlockLines = [];
      currentBlockStart = idx + 1;
    } else if (currentShiftDate !== null) {
      currentBlockLines.push(line);
    }
  });
  flushBlock();

  return events;
}

module.exports = { loadMarkdownEvents };
