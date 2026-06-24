/**
 * logger.js — structured JSON-line logger.
 * Every entry is tagged with hotelId + shiftDate + stage so a bad handover
 * is debuggable: grep the log for hotelId+date to replay a specific run.
 */

function log(level, stage, message, context = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    stage,
    message,
    ...context,
  };
  // Write to stderr so structured logs don't pollute JSON API responses on stdout
  process.stderr.write(JSON.stringify(entry) + "\n");
}

const logger = {
  info:  (stage, message, ctx) => log("info",  stage, message, ctx),
  warn:  (stage, message, ctx) => log("warn",  stage, message, ctx),
  error: (stage, message, ctx) => log("error", stage, message, ctx),
};

module.exports = { logger };
