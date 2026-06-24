# AGENTS.md

Operating rules for this build. Read this and `TODO.md` before writing
any code, and check back against both before each major step. If what
you're about to do drifts from what's written here, stop and flag it
instead of continuing.

## What this service does

Generates a night-shift handover for a hotel front desk: ingests a
week of front-desk events (structured JSON + one night of free-text
notes), reconciles issues across multiple nights, and outputs an
action-first summary for the morning manager.

## Hard constraints — do not drift from these

- **No LLM call.** No API key is available right now. Build the
  free-text parser as rule-based (keyword/pattern matching). Leave a
  clear seam (a single function/module) where a model call could slot
  in later — note it in comments, don't build it half-wired.
- **No caller-provided history.** The service reads the full
  `events.json` + `night-logs.md` itself on every request and does
  cross-night reconciliation in memory, scoped to whatever date is
  requested. The caller only provides `hotelId` + `date`. This is
  still fully stateless — no database, no writes — it just means the
  service does its own reconciliation instead of pushing that work
  back onto whoever calls it.
- **No persistent store, no auth.** Both are explicitly out of scope
  for a 2-hour test. Flag both in `DECISIONS.md`, don't silently skip
  them.
- **Grounding is non-negotiable.** Every item in the handover output
  must carry a `sourceRef` pointing at exactly which input line/record
  it came from (file + line number for free text, file + record id for
  structured events). Never write a sentence in the handover that
  isn't a near-direct restatement of a sourceRef's content. If a
  status or category can't be confidently determined, mark it
  `unknown` and route it to a flagged/review list — never guess.

## Module boundaries

- `ingest` — turns raw input (any format) into ONE normalized event
  shape: `{ id, hotelId, shiftDate, timestamp, category, status,
  description, sourceRef }`. Nothing outside this module should ever
  read raw JSON/markdown directly.
- `reconcile` — groups normalized events into threads (same issue
  across nights) and classifies each thread as `still_open` /
  `newly_resolved` / `new_tonight` for a target date. Has no knowledge
  of input file formats — only consumes the normalized shape.
- `handover` — turns classified threads into the manager-facing
  summary (JSON + HTML). Only ever emits sourceRef-backed content.
- `logger` — structured (JSON-line) logs, every entry tagged with
  hotelId + shiftDate + stage, so a bad handover is debuggable.

## Working process for this session

- Plan before building. Stop and show me the plan; wait for my
  go-ahead before writing code.
- Check `TODO.md` before each major step. If you're about to do
  something not on it, or skip something that is, say so explicitly —
  don't just proceed.
- If I interject with `/btw`, treat it as a redirect: stop the current
  approach, explain what you think I'm flagging, and confirm before
  continuing.
- Log any redirect in `TODO.md`'s "Redirect log" section, briefly —
  this feeds `DECISIONS.md` later.

## If you're an agent extending this later

Don't add a "smart rewrite" step in `handover` that loses the
sourceRef linkage. If an LLM is added later, it belongs in `ingest`
(parsing free text into normalized events, one sourceRef per output
event) or as an isolated prose-polish pass that takes already-grounded
bullets and only restyles wording — never one that sees the full raw
log and free-associates a summary.