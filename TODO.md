# TODO — Vouch Handover Build

## Build order
- [ ] Ingest: normalize events.json (structured) + night-logs.md (free text) 
      into one event shape, each carrying a sourceRef back to origin
- [ ] Reconcile: thread-match issues across nights (explicit ID if present, 
      fallback heuristic if not) — classify still_open / newly_resolved / 
      new_tonight for a target date
- [ ] Handover: action-first summary (JSON + HTML), every item traceable 
      to a sourceRef, nothing asserted that isn't grounded
- [ ] Structured logging: every stage logs hotelId + shiftDate + stage
- [ ] API surface: GET /handover?hotelId=&date= (JSON), 
      /handover/view?... (HTML)
- [ ] Deploy to Vercel, get a working curl command
- [ ] AGENTS.md / DECISIONS.md written honestly, not templated
- [ ] Export this session as the AI conversation deliverable

## Hard constraints (do not drift from these)
- No LLM call — rule-based parser only, no API key available. Note in 
  code/docs where a model call would slot in instead.
- Service does its OWN cross-night reconciliation by reading the full 
  data files per request — caller does NOT pass in history, no DB either.
- Every handover output item must carry a sourceRef. No synthesized 
  sentences that aren't a restatement of a source line/record.
- Stateless — no persistent store, no auth. Both explicitly flagged as 
  out-of-scope-for-2-hours in DECISIONS.md, not silently skipped.

## Redirect log
(add a line here any time you have to pull it back with /btw, so 
DECISIONS.md's "where AI got in the way" has real examples)