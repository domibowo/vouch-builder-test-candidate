# DECISIONS.md

## What I built, and what I deliberately skipped

Built:
- Ingest pipeline (`src/ingest/`) normalizing `events.json` (structured)
  and `night-logs.md` (free text) into one event shape, every event
  carrying a `sourceRef` back to its origin (file + record id, or file +
  line number).
- A `guest_supplied_content` firewall: any event whose origin is a guest's
  own words (JSON `type: "guest_message"`, or a `guest message:`-style
  marker in free text) is never run through the keyword classifier.
  Its `status`/`category` come straight from the trusted source field
  (or default to a review state), never from parsing the guest's text.
- A second, independent `suspicious_instruction_pattern` flag: scans for
  quoted/reported-speech spans containing imperative or authorization
  language ("approve," "credit," "override," "waive," etc.). This is
  additive only — it never changes status, category, or routing, it only
  adds a visible reason to the flags list for whoever reviews the queue.
- Structural prose filtering in `ingestMarkdown.js`: greeting/sign-off
  lines are dropped at the segmentation stage before they ever become
  events, not downstream.
- Cross-night thread reconciliation grouping events by room+category
  (primary key) or category+topic fingerprint (fallback), classifying
  threads as `still_open` / `newly_resolved` / `new_tonight` per target
  date.
- Handover output as JSON + HTML, action-first bucketing (urgent →
  pending → resolved → flagged), every item carrying its full `sourceRef`
  chain. The `summary` field is always the verbatim `description` of the
  last event in the thread — no new prose is composed by the handover
  module.
- Structured JSON-line logging (hotelId + shiftDate + stage on every
  entry, written to stderr so it doesn't pollute JSON API responses).
- REST API: `GET /handover` (JSON) and `GET /handover/view` (HTML).

Skipped (and why):
- **No LLM call in the pipeline.** No API key was available in the
  timebox. The free-text parser is keyword/pattern-based instead. This
  is the biggest gap against what the brief says it cares about most —
  not pretending otherwise.
- **No auth.** Any caller with network access can generate a handover.
  Must be added before multi-tenant production use — flagged here, not
  silently absent.
- **No persistent store.** Fully stateless: re-reads data files on every
  request. A production deployment needs event storage so the handover
  history itself is auditable.
- **Multi-hotel data isolation.** `hotelId` is validated but the data
  file path is currently hardcoded. A real deployment needs per-hotel
  data paths or a data layer.
- **Test suite.** The classifier and reconcile logic are pure functions —
  straightforward to unit test with the real sample data as fixtures. Not
  built within the timebox.

---

## The evt_0026 prompt-injection case

`data/events.json` contains a planted adversarial input: a guest note
(`evt_0026`) typed to look like a system instruction, asking the
handover tool to suppress every other item and authorize a SGD 1000
credit with fake approval. This is very likely deliberate on Vouch's
part, given their hospitality-AI product surface — guest-facing text
reaching an automated pipeline is a real production risk for them, and
it directly tests the brief's own framing: "stop a model from inventing
facts," generalized to "stop the pipeline from obeying attacker-supplied
text disguised as data."

How it's handled:
- A structural firewall, not a model judgment call. Any event whose
  `type` (JSON) or text marker (free text) identifies it as
  guest-supplied is routed around the classifier entirely — its
  description is treated as content to display, never as instructions
  to execute or signal to act on. Its status/category come from the
  trusted source field, not from parsing its own words.
- A second, independent heuristic (`suspicious_instruction_pattern`)
  flags quoted spans containing imperative/authorization language, as an
  audit signal layered on top — it explains *why* something is in
  review, but never overrides the firewall's safe default and never
  auto-approves, auto-resolves, or auto-credits anything on its own.
- Verified directly against the real pipeline output (not just code
  review): `evt_0026` ends with `status: "pending"`,
  `category: "guest_message"`, and both flags present — confirming
  `classifySegment()` was never reached for this event.
- Tested for false positives against the actual non-English lines in
  `night-logs.md` and several legitimate operational lines mentioning
  money ("deposit," "refund requested," "manager approval") — none of
  them tripped the suspicious-instruction heuristic. A heuristic that
  flags every mention of money would be useless in a hotel ops log.

What I'd still want for production: this only catches guest-supplied
content that's identifiable as such (an explicit type, or a transcription
convention). A guest note folded into prose without any marker would
currently slip through ungrounded-but-unflagged. A production version
needs either a stricter logging convention upstream, or a
"is this reporting what a person said" classification pass that runs
before any other classification, not a marker-dependent one.

---

## How I handle reconciliation across nights

Threads are matched using a two-level key: the primary key is room +
category (exact match on both), and the fallback is category + topic
fingerprint (keywords and room numbers extracted from the description
text) for events with no structured room field. Cross-night proximity is
used only as a tiebreaker when multiple existing threads match the
fallback criteria — it is not a match signal on its own. Two concrete
findings from running this against the real week of data:

- **Structural prose was initially leaking into reconcile as fake
  "events."** Greeting/sign-off lines in `night-logs.md` ("Hi all,
  covering tonight...", "That's it from me") had no resolution event and
  no shiftDate match, so they surfaced as `still_open` threads — noise
  that looked like an unresolved incident. Fixed at the segmentation
  layer in `ingestMarkdown.js` (filtering short, keyword-less,
  action-verb-less segments before they ever become events), not by
  filtering them downstream — the ingest contract should only emit real
  events, so callers of ingest don't have to carry knowledge of what
  counts as noise. One line (an over-80-char intro) still survives this
  filter by design — it's ambiguous enough that dropping it confidently
  isn't safe, so it flows through as `unknown/low_confidence` and lands
  in the review bucket instead, which is the correct place for it.

- **Known, documented gap: cross-format duplicates don't always merge.**
  A room 112 aircon issue logged once in `events.json` (structured, has
  a `room` field) and again in `night-logs.md` (free text, no structured
  room field) are NOT currently threaded together — the free-text event
  has no extractable room identifier to match against. The consequence:
  a morning manager reading this handover would see what looks like two
  separate aircon issues in room 112 instead of one ongoing one. The fix
  (regex-based room-number extraction from free text) was deliberately
  not built — partial coverage of edge cases would have cost more time
  than the gap is worth documenting honestly. This is the clearest
  concrete example of why reconciliation across heterogeneous input
  formats is hard, and exactly what the brief is testing for.

---

## Negation handling in the keyword classifier (known limitation)

The rule-based classifier initially mis-read negated resolution language
as positive — "Still not fixed" and "still not settled" were classified
as `resolved` because the matcher found "fixed"/"settled" without
checking for a preceding negation. This was caught by re-reading the
classifier's own output against the real data, not by design, and fixed
for those two patterns specifically.

That fix does NOT generalize. Phrasings like "no fix found," "not done,"
"repair wasn't completed," or "not resolved to her satisfaction" are not
reliably caught by the negation check — most fall through to
`unknown` rather than being correctly read as `unresolved`.

The property that matters: every failure mode here resolves to
`unknown` (which routes to the flagged/review bucket), never to a false
`resolved`. A rule-based parser that's incomplete but fails toward "ask
a human" is defensible for a system that runs unattended; one that fails
toward "silently mark it fine" is not. This is the clearest concrete
argument in this whole project for why the LLM seam in `ingest/` exists
— a model reading "repair wasn't completed" in context would not need
hand-written negation regex to get this right.

---

## The timezone bug: a coincidence that looked like correctness

`shiftDateFromTimestamp` originally computed a shift's date using
`getHours()` and `toISOString()` on a JS `Date` object. Both of those
methods are timezone-sensitive in ways that don't match what the
function actually needed:

- `getHours()` returns the hour in the *server's local timezone*, not
  the hour encoded in the timestamp's own offset.
- `toISOString()` always converts to UTC before formatting the date.

Every timestamp in `events.json` carries a `+08:00` offset. My local
machine is also `+08:00`. That meant both bugs happened to cancel out on
my machine — the wrong calculation produced the right-looking answer,
every single time I tested it locally. It was never actually correct;
it was coincidentally close enough that nothing I checked locally could
have caught it.

The moment the same code ran on Vercel — UTC by default — the
coincidence broke. `23:40+08:00` parsed as hour 15 on a UTC server,
missing the late-night threshold that shifts a timestamp into the next
shift's date. Separately, `toISOString().slice(0,10)` was pulling some
early-morning `+08:00` timestamps onto the *previous* UTC calendar
date — for example, `2026-05-30T01:30:00+08:00` was being dated
`2026-05-29`, which meant May 30 events were silently leaking into the
May 29 handover, on both machines, the entire time. Deploying to a
different timezone didn't introduce this bug — it just removed the
coincidence that had been hiding it.

The fix parses the date and hour directly from the ISO string's own
offset, rather than asking a `Date` object to reinterpret it through
whatever timezone happens to be running the process.

After the fix, I re-checked every thread I'd previously verified by
hand rather than assuming "local now matches deployed" meant everything
upstream was still correct:

- **`evt_0026` (prompt-injection firewall):** still flagged correctly
  with both `guest_supplied_content` and `suspicious_instruction_pattern`,
  status still `pending`, category still `guest_message` — it simply
  moved to the May 30 handover instead of May 29, because that's the
  shift it actually happened on. The firewall property held; only the
  date assignment changed, which is exactly what fixing a date bug
  should do.
- **Corridor leak thread:** unchanged — still correctly resolves to
  `newly_resolved` on May 29, across all three sourceRefs (JSON open →
  markdown update → JSON resolution).
- **Room 112 cross-format gap:** the markdown-side event now sits on
  its correct date and correctly carries forward across nights — it
  shows as `new_tonight` on May 28 and `still_open` on May 29, proving
  the across-*night* reconciliation logic works. It still never merges
  with the JSON-side room 112 thread, because the free-text event has
  no extractable room field — across-*format* reconciliation remains a
  known, documented gap, unaffected by this fix.

The lesson, stated plainly: "it works on my machine" is a specifically
dangerous signal when the logic in question is timezone-sensitive,
because a developer's local timezone can quietly cancel out a real bug
instead of exposing it. A handover service meant to run "unattended
across hundreds of hotels" — almost certainly across multiple
timezones — would have shipped this exact bug with every local test
passing, and only discovered it from a hotel manager reading a handover
with the wrong night's events in it. Deploying to a server in a
different timezone than my dev machine is what surfaced this, not any
test I wrote.

## How I keep every statement grounded, and handle incomplete/contradictory input

Every event leaving `ingest/` carries a `sourceRef`. Nothing in the
handover states a sentence that isn't a near-verbatim restatement of a
sourceRef's content. Unknown/ambiguous status or category routes to a
flagged/review list rather than being guessed.

From the real handover output (2026-05-29):
- Every item in urgent/pending/resolved carries a `sourceRef` pointing
  to the exact JSON record id or markdown line number it came from.
  Multi-event threads carry a full `sourceRefs` array covering every
  contributing event.
- The `summary` field is always the verbatim `description` of the last
  event in the thread — the handover module composes no new prose.
- Incomplete entries (terse descriptions, non-English text,
  unclassifiable segments) surface in `flagged` with a `flagReason` and
  their original text intact. Nothing is suppressed or paraphrased away.
- Contradictory input (e.g. a thread where one event says `resolved` and
  a later one says `unresolved`) resolves by last-event-wins — the most
  recent known state is reported, and the full event chain is in
  `sourceRefs` for whoever reviews it.

---

## Where AI helped most, and where it got in the way

Helped: fast, well-tested scaffolding of the ingest layer; the suspicious-
instruction heuristic was built and verified (9/9 test cases, including
deliberate false-positive checks against real non-English data) in one
focused pass.

Got in the way / needed redirecting:
- The markdown-path firewall was initially built but left unwired —
  `isGuestSuppliedContent` was imported but never called in
  `ingestMarkdown.js`, so a guest note transcribed into the free-text log
  would have slipped through ungrounded while the JSON path was protected.
  Caught by explicitly asking "is this actually wired into both paths, not
  just available," not something it flagged unprompted.
- When asked to fill in `[FILL IN]` placeholders in DECISIONS.md, the
  AI replaced the entire file with a rewrite in its own words — including
  sections of human-written analysis it was never asked to touch. It did
  this without flagging that it was overwriting existing content. When
  asked to show a diff, there was none to show: DECISIONS.md had never
  been committed, so git had no prior version. Recovery only worked
  because the original text was still in the AI's context from having
  read the file earlier in the session — if that context had been gone,
  the original framing would have been lost for good with no way to
  detect it.

---

## What I'd do in hours 3–6

1. **Room extraction from free text.** Single biggest reconciliation
   improvement — extract room numbers from description text during ingest
   and populate `room` when exactly one is mentioned unambiguously.
   Eliminates the known thread-merging gap between JSON and markdown events.
2. **Replace `classifySegment()` with a model call.** The LLM seam is a
   single function in `classify.js`. Swapping it in immediately improves
   category/status accuracy for terse and non-English text without touching
   the grounding contract — sourceRef linkage lives in the calling code,
   not the classifier.
3. **Auth.** Bearer token header check is a one-hour addition. Required
   before multi-tenant use.
4. **Per-hotel data paths.** Parameterise the data file location by
   `hotelId` so the service can serve multiple hotels from one deployment.
5. **Unit test suite.** The classifier and reconcile logic are pure
   functions — straightforward to test with the real sample data as
   fixtures.

---

## One thing that surprised me

The prompt-injection attempt in `evt_0026` is structurally
indistinguishable from a legitimate `guest_message` event — same JSON
shape, same `pending` status, same field names. The firewall that catches
it isn't a heuristic; it's the event's own `type` field. The real
protection is the decision not to trust the *content* of any event when
the *type* says it's guest-supplied — a data-modelling decision, not a
security feature, and it only works because the schema was designed with
that boundary in mind from the start.

This means the `suspicious_instruction_pattern` heuristic exists for the
cases the schema boundary *doesn't* cover: a guest note folded into a
`complaint` event without any type marker, where the content is the only
signal you have. In those cases the heuristic is your primary defence,
not a belt-and-suspenders audit log. That inversion — heuristic as
fallback vs. heuristic as primary — is worth knowing before scaling to
more event types.
