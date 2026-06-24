/**
 * reconcile/index.js — group normalized events into threads, classify each
 * thread as still_open / newly_resolved / new_tonight for a target date.
 *
 * Consumes only the normalized event shape from src/ingest — has no knowledge
 * of raw JSON or markdown formats.
 *
 * Thread matching priority:
 *   1. PRIMARY: same room + same category (room must be non-null on both)
 *   2. FALLBACK: same category + overlapping topic fingerprint (for room=null events)
 *   3. ISOLATED: events flagged guest_supplied_content are never merged into
 *      other threads and never used as a resolve/merge signal.
 */

// ---------------------------------------------------------------------------
// Topic fingerprinting for room=null events
// ---------------------------------------------------------------------------

// Room-number mentions inside description text (e.g. "near room 215", "215").
const ROOM_MENTION_RE = /\brooms?\s*(\d{2,3})\b/gi;

// High-signal nouns that distinguish issues when room is absent.
const TOPIC_KEYWORDS = [
  "leak", "drip", "corridor", "water",
  "scanner", "immigration", "passport",
  "wifi", "internet",
  "aircon", "compressor",
  "safe", "保险箱",
  "breakfast", "kitchen",
  "elevator", "lift",
  "fire", "smoke",
];

function topicFingerprint(description) {
  const tokens = new Set();
  const lower = description.toLowerCase();

  // Extract room numbers mentioned in text
  let m;
  const re = new RegExp(ROOM_MENTION_RE.source, "gi");
  while ((m = re.exec(description)) !== null) {
    tokens.add(`room:${m[1]}`);
  }

  // Extract topic keywords
  for (const kw of TOPIC_KEYWORDS) {
    if (lower.includes(kw)) tokens.add(`kw:${kw}`);
  }

  return tokens;
}

function fingerprintOverlap(a, b) {
  for (const token of a) {
    if (b.has(token)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Thread matching
// ---------------------------------------------------------------------------

/**
 * Returns a match key for an event, or null if the event should be isolated.
 * Events with the same key are candidates for the same thread (pending
 * fingerprint confirmation for room=null events).
 */
function primaryKey(event) {
  if (event.flags.includes("guest_supplied_content")) return null; // always isolated
  if (event.room !== undefined && event.room !== null) {
    return `${event.category}::room:${event.room}`;
  }
  return null; // room=null: use fallback fingerprint matching
}

/**
 * Group events into threads. Returns Thread[]:
 *   { id, category, room, events[], fingerprint }
 */
function buildThreads(events) {
  const threads = [];
  const keyIndex = new Map(); // primaryKey -> thread index

  for (const event of events) {
    // guest_supplied_content: always its own isolated thread
    if (event.flags.includes("guest_supplied_content")) {
      threads.push({
        id: `thread-${threads.length + 1}`,
        category: event.category,
        room: event.room ?? null,
        events: [event],
        fingerprint: new Set(),
        isolated: true,
      });
      continue;
    }

    const key = primaryKey(event);

    if (key) {
      // PRIMARY match: room + category
      if (keyIndex.has(key)) {
        threads[keyIndex.get(key)].events.push(event);
      } else {
        keyIndex.set(key, threads.length);
        threads.push({
          id: `thread-${threads.length + 1}`,
          category: event.category,
          room: event.room ?? null,
          events: [event],
          fingerprint: new Set(),
          isolated: false,
        });
      }
    } else {
      // FALLBACK: category + fingerprint overlap (room=null events)
      const fp = topicFingerprint(event.description);
      let matched = false;

      if (fp.size > 0) {
        // Find the closest-in-time existing thread with same category and overlapping fingerprint
        let bestIdx = -1;
        let bestGap = Infinity;
        for (let i = 0; i < threads.length; i++) {
          const t = threads[i];
          if (t.isolated) continue;
          if (t.room !== null) continue; // primary-keyed threads don't absorb room=null events
          if (t.category !== event.category) continue;
          if (!fingerprintOverlap(fp, t.fingerprint)) continue;

          // Tiebreaker: prefer thread whose last event is temporally closest
          const lastEvt = t.events[t.events.length - 1];
          const gap = event.timestamp && lastEvt.timestamp
            ? Math.abs(new Date(event.timestamp) - new Date(lastEvt.timestamp))
            : 0;
          if (bestIdx === -1 || gap < bestGap) {
            bestIdx = i;
            bestGap = gap;
          }
        }

        if (bestIdx !== -1) {
          // Merge fingerprints so subsequent events can match on accumulated tokens
          for (const tok of fp) threads[bestIdx].fingerprint.add(tok);
          threads[bestIdx].events.push(event);
          matched = true;
        }
      }

      if (!matched) {
        // No existing thread matches — start a new one
        const newThread = {
          id: `thread-${threads.length + 1}`,
          category: event.category,
          room: event.room ?? null,
          events: [event],
          fingerprint: fp,
          isolated: false,
        };
        threads.push(newThread);
      }
    }
  }

  return threads;
}

// ---------------------------------------------------------------------------
// Thread classification for a target date
// ---------------------------------------------------------------------------

/**
 * A shift for targetDate covers timestamps from the previous evening 23:00
 * through targetDate 07:00.  shiftDate on a normalized event is already the
 * morning date, so we simply compare shiftDate strings.
 */
function classifyThread(thread, targetDate) {
  const { events, isolated } = thread;

  // Partition events into "prior shifts" and "tonight's shift"
  const priorEvents = events.filter((e) => e.shiftDate < targetDate);
  const tonightEvents = events.filter((e) => e.shiftDate === targetDate);

  // Isolated threads (guest_supplied_content) are always their own category
  if (isolated) {
    const relevantEvents = tonightEvents.length ? tonightEvents : priorEvents;
    if (!relevantEvents.length) return null; // outside target window entirely
    return { classification: "flagged", priorEvents, tonightEvents };
  }

  // Thread has no events relevant to this date or before it — skip
  if (!priorEvents.length && !tonightEvents.length) return null;

  // Determine the thread's status as of the end of prior shifts
  const lastPriorStatus = lastEffectiveStatus(priorEvents);

  if (!tonightEvents.length) {
    // Thread exists from prior shifts but nothing happened tonight
    if (lastPriorStatus === "resolved") return null; // already closed, not relevant
    return { classification: "still_open", priorEvents, tonightEvents };
  }

  if (!priorEvents.length) {
    // Entirely new tonight
    return { classification: "new_tonight", priorEvents, tonightEvents };
  }

  // Thread spans prior + tonight: did tonight resolve it?
  const lastTonightStatus = lastEffectiveStatus(tonightEvents);
  if (lastPriorStatus !== "resolved" && lastTonightStatus === "resolved") {
    return { classification: "newly_resolved", priorEvents, tonightEvents };
  }
  if (lastPriorStatus !== "resolved") {
    return { classification: "still_open", priorEvents, tonightEvents };
  }

  return null; // was already resolved before tonight, not surfaced
}

/**
 * Determine the effective status of a set of events by taking the last
 * explicit status, preferring "resolved" if any event is resolved.
 * guest_supplied_content events are excluded — their status is not
 * operational evidence of an issue being closed.
 */
function lastEffectiveStatus(events) {
  const operational = events.filter(
    (e) => !e.flags.includes("guest_supplied_content")
  );
  if (!operational.length) return "unknown";

  // If any event is resolved, treat the thread state as resolved at that point
  // (a later unresolved event on the same thread reopens it)
  let status = operational[0].status;
  for (const e of operational) {
    status = e.status; // walk forward; last explicit status wins
  }
  return status ?? "unknown";
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Given all normalized events and a target date (ISO "YYYY-MM-DD"),
 * returns classified threads grouped by classification bucket.
 *
 * guest_supplied_content events appear in `flagged` only — they are never
 * used as a signal to resolve or merge any other thread.
 */
function reconcile(events, targetDate) {
  const threads = buildThreads(events);

  const result = {
    targetDate,
    stillOpen: [],
    newlyResolved: [],
    newTonight: [],
    flagged: [],
  };

  for (const thread of threads) {
    const classified = classifyThread(thread, targetDate);
    if (!classified) continue;

    const entry = {
      threadId: thread.id,
      category: thread.category,
      room: thread.room,
      classification: classified.classification,
      priorEvents: classified.priorEvents,
      tonightEvents: classified.tonightEvents,
    };

    switch (classified.classification) {
      case "still_open":    result.stillOpen.push(entry);    break;
      case "newly_resolved": result.newlyResolved.push(entry); break;
      case "new_tonight":   result.newTonight.push(entry);   break;
      case "flagged":       result.flagged.push(entry);       break;
    }
  }

  return result;
}

module.exports = { reconcile };
