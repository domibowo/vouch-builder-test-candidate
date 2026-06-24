/**
 * classify.js — rule-based category + status inference for free-text segments.
 *
 * FIREWALL: call isGuestSuppliedContent(rawType) BEFORE calling any function
 * in this file. If it returns true, do NOT pass the description text here.
 * Guest-supplied content is display-only data; its description must never be
 * keyword-matched to infer category, status, or affect any other thread.
 *
 * LLM SEAM: classifySegment() is the single function to replace with a model
 * call when an API key is available. Its contract is:
 *   (text: string) => { category: string, status: string, confidence: "high"|"low" }
 * Everything else in this file can be deleted at that point.
 */

// Types whose description text is guest-supplied data, not operational signal.
// The source record's own `status` field is authoritative; description is verbatim display only.
const GUEST_SUPPLIED_TYPES = new Set([
  "guest_message",
  "complaint_note", // reserved for future use
]);

/**
 * Returns true if this event type (JSON) or free-text marker (markdown) signals
 * guest-supplied content. When true, callers MUST treat the description as
 * verbatim display data and MUST NOT pass it to classifySegment().
 *
 * For JSON events: pass raw.type (e.g. "guest_message").
 * For markdown segments: pass the detected marker (e.g. "guest_message").
 */
function isGuestSuppliedContent(rawType) {
  return GUEST_SUPPLIED_TYPES.has(rawType);
}

// Prefixes a relief staffer might write when transcribing a guest note into
// the free-text log. Checked before classification; matched text is treated
// identically to a JSON event with type "guest_message".
const GUEST_MESSAGE_PREFIXES = [
  /^guest\s*message\s*:/i,
  /^guest\s*note\s*:/i,
  /^note\s*from\s*guest\s*:/i,
];

/**
 * If the segment text starts with a guest-message marker, returns
 * { isGuest: true, strippedText } so the caller can store the cleaned
 * description while still knowing not to classify it.
 * Otherwise returns { isGuest: false }.
 */
function detectGuestMessageMarker(text) {
  for (const re of GUEST_MESSAGE_PREFIXES) {
    if (re.test(text)) {
      return { isGuest: true, strippedText: text.replace(re, "").trim() };
    }
  }
  return { isGuest: false };
}

// ---------------------------------------------------------------------------
// Keyword tables — order matters: first match wins within each category group.
// ---------------------------------------------------------------------------

const CATEGORY_RULES = [
  { category: "compliance",   keywords: ["immigration", "passport", "scanner", "scanning", "submitting", "reporting deadline"] },
  { category: "maintenance",  keywords: ["aircon", "compressor", "repair", "out of order", "safe", "保险箱", "broken", "cracked", "basin"] },
  { category: "finance",      keywords: ["deposit", "charge", "refund", "invoice", "no-show", "credit", "fee", "payment", "card", "billing", "prepaid"] },
  { category: "facilities",   keywords: ["wifi", "water", "leak", "drip", "corridor", "lobby", "coffee machine", "bucket", "wet floor", "carpet"] },
  { category: "complaint",    keywords: ["complaint", "complain", "angry", "noise", "unhappy", "upset", "breakfast", "promised"] },
  { category: "incident",     keywords: ["unwell", "medication", "ambulance", "sick", "injury", "medical"] },
  { category: "check_in",     keywords: ["check-in", "check in", "checked in", "late arrival", "keycard", "room key"] },
  { category: "deposit",      keywords: ["deposit declined", "card declined"] },
  { category: "note",         keywords: ["parcel", "package", "message", "holding", "fyi", "for your info"] },
];

const STATUS_RULES = [
  { status: "resolved",   keywords: ["resolved", "fixed", "settled", "sorted", "closed", "done", "completed", "mopped", "dry", "stopped", "deactivated", "fine now"] },
  { status: "unresolved", keywords: ["unresolved", "not fixed", "still open", "needs follow-up", "needs to be", "still not", "no one came", "passing it on", "still no deposit", "backlog", "not yet", "still out of order", "still waiting"] },
  { status: "pending",    keywords: ["pending", "to confirm", "to decide", "leaving for morning", "flagging", "flag", "please chase", "someone should", "needs investigation", "no photos", "no manager approval"] },
];

/**
 * Infer category from text. Returns "unknown" if no rule matches.
 */
function inferCategory(text) {
  const lower = text.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return rule.category;
    }
  }
  return "unknown";
}

// Negation words that, when appearing within 4 words before a status keyword,
// flip the match — "still not fixed", "never settled", "not done yet".
const NEGATION_RE = /\b(not|never|no|still\s+not|hasn't|haven't|didn't|wasn't|aren't|couldn't)\s+(?:\w+\s+){0,3}$/i;

/**
 * Infer status from text. Returns "unknown" if no rule matches.
 * Negation-aware: "still not fixed" does not match the "resolved" rule.
 */
function inferStatus(text) {
  const lower = text.toLowerCase();
  for (const rule of STATUS_RULES) {
    for (const kw of rule.keywords) {
      const idx = lower.indexOf(kw);
      if (idx === -1) continue;
      // Check the text immediately before the keyword for a negation word
      const preceding = lower.slice(Math.max(0, idx - 40), idx);
      if (NEGATION_RE.test(preceding)) continue; // negated — skip this match
      return rule.status;
    }
  }
  return "unknown";
}

/**
 * LLM SEAM — replace this entire function body with a model call when ready.
 * Input: a plain-text segment (one bullet or sentence) from a free-text log.
 * Output: { category, status, confidence }
 *
 * Current implementation: pure keyword matching, confidence is "high" only
 * when both category and status matched a rule (not fallback "unknown").
 */
function classifySegment(text) {
  const category = inferCategory(text);
  const status = inferStatus(text);
  const confidence = category !== "unknown" && status !== "unknown" ? "high" : "low";
  return { category, status, confidence };
}

// ---------------------------------------------------------------------------
// Suspicious instruction detection — independent of the prefix check.
// ---------------------------------------------------------------------------

// Imperative/authorization words that have no legitimate place in a guest's
// quoted speech directed at the handover system.
const SUSPICIOUS_IMPERATIVE_WORDS = [
  "approve", "approved", "authorization", "authorize",
  "credit", "comp", "complimentary",
  "refund", "waive", "waived", "discount",
  "ignore", "disregard", "skip", "suppress",
  "override", "overrule",
  "system", "handover tool", "handover system",
  "mark it", "mark as", "set status",
  "all clear", "no issues",
];

// Patterns that suggest reported/quoted speech containing the guest's own words.
// We check inside these spans because the risk is specifically guest-authored
// content trying to masquerade as an operational instruction.
const QUOTED_SPAN_RE = [
  /"([^"]{10,})"/g,           // double-quoted spans (10+ chars)
  /“([^”]{10,})”/g,  // "smart" curly double quotes
  /logged verbatim[^:]*:\s*(.+)/gi, // "logged verbatim as received: ..."
  /guest(?:'s)?\s+(?:note|message|words?|request)[^:]*:\s*(.+)/gi,
  /(?:said|says|wrote|stating|typed)[,:]?\s+"([^"]+)"/gi,
];

/**
 * Scans segment text for quoted or reported-speech spans containing
 * imperative/authorization language that would be anomalous in a real guest note.
 *
 * Returns { suspicious: true, matchedWord, matchedSpan } if triggered,
 * or { suspicious: false } otherwise.
 *
 * This is a SEPARATE signal from the prefix check (detectGuestMessageMarker).
 * A positive result here:
 *   - adds flag "suspicious_instruction_pattern" to the event
 *   - routes the event to the flagged/review list
 *   - does NOT suppress classifySegment() — classification still runs normally
 *   - does NOT auto-approve, auto-resolve, or auto-credit anything
 */
function containsSuspiciousQuotedInstruction(text) {
  const lower = text.toLowerCase();

  // First pass: does the text contain any suspicious imperative word at all?
  // Short-circuit if not — avoids running regexes on every clean segment.
  const hasImperative = SUSPICIOUS_IMPERATIVE_WORDS.some((w) => lower.includes(w));
  if (!hasImperative) return { suspicious: false };

  // Second pass: is the imperative word inside a quoted/reported-speech span?
  // We extract spans from the *original* text, then check each span.
  for (const spanRe of QUOTED_SPAN_RE) {
    // Reset lastIndex for global regexes (they're reused across calls)
    spanRe.lastIndex = 0;
    let m;
    while ((m = spanRe.exec(text)) !== null) {
      const span = (m[1] || "").toLowerCase();
      const hit = SUSPICIOUS_IMPERATIVE_WORDS.find((w) => span.includes(w));
      if (hit) {
        return { suspicious: true, matchedWord: hit, matchedSpan: m[1] || m[0] };
      }
    }
  }

  // Imperative word present but not inside a quoted/reported span.
  // Legitimate operational language ("refund requested", "credit card taken")
  // falls here — not flagged.
  return { suspicious: false };
}

/**
 * Detect likely non-English content by low ASCII-letter ratio.
 * Used to flag segments that the rule-based classifier may not parse reliably.
 */
function isLikelyNonEnglish(text) {
  const letters = text.replace(/[^a-zA-Z一-鿿]/g, "");
  if (letters.length === 0) return false;
  const asciiLetters = text.replace(/[^a-zA-Z]/g, "");
  const cjk = text.replace(/[^一-鿿]/g, "");
  return cjk.length > asciiLetters.length * 0.3;
}

module.exports = { isGuestSuppliedContent, detectGuestMessageMarker, containsSuspiciousQuotedInstruction, classifySegment, isLikelyNonEnglish };
