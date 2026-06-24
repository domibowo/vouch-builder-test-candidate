const express = require("express");
const { loadAllEvents } = require("./ingest");
const { reconcile } = require("./reconcile");
const { buildHandover } = require("./handover");
const { renderHtml } = require("./handover/renderHtml");
const { logger } = require("./logger");

const app = express();

// Supported hotels — in production this would come from a data layer.
const KNOWN_HOTELS = new Set(["lumen-sg"]);

// ISO date validation: YYYY-MM-DD
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateParams(req, res) {
  const { hotelId, date } = req.query;
  if (!hotelId) return res.status(400).json({ error: "missing hotelId query param" });
  if (!KNOWN_HOTELS.has(hotelId)) return res.status(404).json({ error: `unknown hotelId: ${hotelId}` });
  if (!date) return res.status(400).json({ error: "missing date query param (YYYY-MM-DD)" });
  if (!DATE_RE.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  return null;
}

function generateHandover(hotelId, date) {
  logger.info("ingest",    "loading events",     { hotelId, shiftDate: date });
  const events = loadAllEvents(hotelId);
  logger.info("ingest",    "events loaded",      { hotelId, shiftDate: date, count: events.length });

  logger.info("reconcile", "reconciling",        { hotelId, shiftDate: date });
  const reconciled = reconcile(events, date);
  logger.info("reconcile", "reconcile complete", {
    hotelId, shiftDate: date,
    stillOpen:     reconciled.stillOpen.length,
    newlyResolved: reconciled.newlyResolved.length,
    newTonight:    reconciled.newTonight.length,
    flagged:       reconciled.flagged.length,
  });

  logger.info("handover",  "building handover",  { hotelId, shiftDate: date });
  const handover = buildHandover(hotelId, date, reconciled);
  logger.info("handover",  "handover built",     { hotelId, shiftDate: date, counts: handover.counts });

  return handover;
}

// GET /handover?hotelId=lumen-sg&date=2026-05-29  → JSON
app.get("/handover", (req, res) => {
  const invalid = validateParams(req, res);
  if (invalid) return;
  const { hotelId, date } = req.query;
  try {
    const handover = generateHandover(hotelId, date);
    res.json(handover);
  } catch (err) {
    logger.error("handover", "unhandled error", { hotelId, shiftDate: date, error: err.message });
    res.status(500).json({ error: "internal error", detail: err.message });
  }
});

// GET /handover/view?hotelId=lumen-sg&date=2026-05-29  → HTML
app.get("/handover/view", (req, res) => {
  const invalid = validateParams(req, res);
  if (invalid) return;
  const { hotelId, date } = req.query;
  try {
    const handover = generateHandover(hotelId, date);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderHtml(handover));
  } catch (err) {
    logger.error("handover", "unhandled error", { hotelId, shiftDate: date, error: err.message });
    res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info("server", `listening on port ${PORT}`, {});
});

module.exports = app;
