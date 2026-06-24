/**
 * handover/index.js — turn classified threads into the manager-facing summary.
 *
 * Every item emitted carries a sourceRef. No sentence is written here that
 * isn't a near-direct restatement of a source event's description field.
 * If a thread can't be summarised with confidence, it goes to flagged.
 *
 * guest_supplied_content threads are always in flagged — they are never
 * promoted to urgent/pending/resolved regardless of their description text.
 */

// ---------------------------------------------------------------------------
// Urgency ordering within each bucket
// ---------------------------------------------------------------------------

// Higher number = shown first within a bucket.
const CATEGORY_URGENCY = {
  compliance:  6,
  incident:    5,
  maintenance: 4,
  finance:     3,
  facilities:  3,
  check_in:    2,
  complaint:   2,
  note:        1,
  unknown:     0,
  guest_message: 0,
};

function urgencyScore(entry) {
  return CATEGORY_URGENCY[entry.category] ?? 0;
}

// ---------------------------------------------------------------------------
// Build a single handover item from a classified thread entry
// ---------------------------------------------------------------------------

/**
 * The summary is the last event's description, verbatim.
 * We pick the last event because it represents the most recent known state
 * of the thread. For multi-event threads the prior context is available in
 * priorEvents for downstream consumers.
 *
 * We never compose a new sentence here — sourceRef integrity requires that
 * every summary string is traceable to a specific input record.
 */
function buildItem(entry) {
  const allEvents = [...entry.priorEvents, ...entry.tonightEvents];
  const lastEvent = allEvents[allEvents.length - 1];
  const firstEvent = allEvents[0];

  // Collect all sourceRefs across the thread so the full audit trail is present
  const sourceRefs = allEvents.map((e) => e.sourceRef);

  // Aggregate flags across all events in the thread
  const flags = [...new Set(allEvents.flatMap((e) => e.flags))];

  // Build a minimal context note when multiple events span multiple shifts —
  // this is metadata, not synthesised prose.
  const shiftDates = [...new Set(allEvents.map((e) => e.shiftDate))].sort();
  const spanNote = shiftDates.length > 1
    ? `Open since ${shiftDates[0]}, last updated ${shiftDates[shiftDates.length - 1]}.`
    : null;

  return {
    threadId:      entry.threadId,
    category:      entry.category,
    classification: entry.classification,
    room:          entry.room,
    // Primary source: last event (most recent state)
    summary:       lastEvent.description,
    sourceRef:     lastEvent.sourceRef,
    // Full thread audit trail
    sourceRefs,
    openedAt:      firstEvent.sourceRef,
    spanNote,
    flags,
    eventCount:    allEvents.length,
  };
}

// ---------------------------------------------------------------------------
// Bucket routing
// ---------------------------------------------------------------------------

/**
 * Route a classified thread entry into one of four output buckets.
 *
 * guest_supplied_content events are hard-routed to flagged regardless of
 * their classification — their description is display-only data and must
 * not promote them to urgent or pending.
 */
function routeToBucket(entry) {
  const allEvents = [...entry.priorEvents, ...entry.tonightEvents];
  const isGuestSupplied = allEvents.some((e) =>
    e.flags.includes("guest_supplied_content")
  );
  if (isGuestSupplied) return "flagged";

  switch (entry.classification) {
    case "newly_resolved": return "resolved";
    case "flagged":        return "flagged";
    case "still_open":
    case "new_tonight": {
      const lastEvent = allEvents[allEvents.length - 1];
      // pending status → pending bucket; unresolved/unknown → urgent
      if (lastEvent.status === "pending") return "pending";
      if (lastEvent.status === "resolved") return "resolved";
      return "urgent";
    }
    default: return "flagged";
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Build the handover JSON for a target date from reconciled thread output.
 * Returns { hotelId, shiftDate, generatedAt, urgent[], pending[], resolved[], flagged[] }.
 */
function buildHandover(hotelId, targetDate, reconciled) {
  const buckets = { urgent: [], pending: [], resolved: [], flagged: [] };

  const allEntries = [
    ...reconciled.stillOpen,
    ...reconciled.newlyResolved,
    ...reconciled.newTonight,
    ...reconciled.flagged,
  ];

  for (const entry of allEntries) {
    // Skip low-signal unknown-category items with no room — these are
    // structural prose that survived segmentation or genuinely ambiguous
    // free-text fragments. Route to flagged rather than urgent.
    const allEvents = [...entry.priorEvents, ...entry.tonightEvents];
    const hasLowConfidence = allEvents.every((e) => e.flags.includes("low_confidence"));
    if (entry.category === "unknown" && hasLowConfidence && !entry.room) {
      const item = buildItem(entry);
      item.flagReason = "unclassifiable_segment";
      buckets.flagged.push(item);
      continue;
    }

    const bucket = routeToBucket(entry);
    const item = buildItem(entry);

    if (bucket === "flagged") {
      // Record why it landed in flagged
      const allEvtFlags = [...entry.priorEvents, ...entry.tonightEvents].flatMap((e) => e.flags);
      if (allEvtFlags.includes("guest_supplied_content")) {
        item.flagReason = "guest_supplied_content";
      } else if (allEvtFlags.includes("suspicious_instruction_pattern")) {
        item.flagReason = "suspicious_instruction_pattern";
      } else if (entry.classification === "flagged") {
        item.flagReason = "isolated_thread";
      } else {
        item.flagReason = "unknown_category_or_status";
      }
    }

    buckets[bucket].push(item);
  }

  // Sort each bucket: higher urgency score first
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => urgencyScore(b) - urgencyScore(a));
  }

  return {
    hotelId,
    shiftDate: targetDate,
    generatedAt: new Date().toISOString(),
    counts: {
      urgent:   buckets.urgent.length,
      pending:  buckets.pending.length,
      resolved: buckets.resolved.length,
      flagged:  buckets.flagged.length,
    },
    urgent:   buckets.urgent,
    pending:  buckets.pending,
    resolved: buckets.resolved,
    flagged:  buckets.flagged,
  };
}

module.exports = { buildHandover };
