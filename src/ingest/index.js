/**
 * Public interface for ingest. No code outside src/ingest/ reads raw data files.
 */

const { loadJsonEvents } = require("./ingestJson");
const { loadMarkdownEvents } = require("./ingestMarkdown");

/**
 * Returns all normalized events for a hotel, from all sources, sorted by timestamp.
 * Caller provides hotelId only — this module owns the file reads.
 */
function loadAllEvents(hotelId) {
  const jsonEvents = loadJsonEvents(hotelId);
  const mdEvents = loadMarkdownEvents(hotelId);
  const all = [...jsonEvents, ...mdEvents];
  // Sort nulls (free-text events with no timestamp) to end of shift
  all.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return new Date(a.timestamp) - new Date(b.timestamp);
  });
  return all;
}

module.exports = { loadAllEvents };
