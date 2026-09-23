# Knowledge engine (replaces the research workflow)

Part of the [Smart Assistant](../README.md) project. Supersedes
[`docs/research-workflow.md`](research-workflow.md) entirely — see that
file for the system this replaced and why it wasn't just extended. See
[`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md) for the
raw-Ollama tool-calling pattern this reuses, and
[`docs/known-gotchas.md`](known-gotchas.md) for the generic n8n/Docker
gotchas referenced below.

**2026-09 — built because the old research pipeline conflated "documents
Amy already has" with "things Amy needs to go find out," had no per-chunk
citation, and no way to combine keyword and semantic search.** The
replacement is one domain-agnostic engine: a Porsche manual PDF and a
Warframe build guide are both just a `documents` row with a `domain`
column, not separate per-hobby systems. Core distinction it's built
around: **knowledge** (Amy already has this, just retrieve it) vs.
**research** (Amy doesn't have it yet — search live, cross-check sources,
optionally save the result back into knowledge).

## Architecture

New service, `knowledge-engine/` (Node/Express/pg, port 3005, internal-only
on `assistant-net`, same scaffolding shape as `event-bus/`). Reuses the
existing `research` Postgres database (pgvector already installed there);
new tables live alongside the old, untouched `research_documents`/
`research_chunks`/`research_log` ones from the old pipeline (left alone,
unmigrated — same precedent as `coding_task_pipeline`'s old Data Tables
when `coding-orchestrator` replaced it).

Schema (`postgres/init/08-create-knowledge-tables.sql`, one-time manual
migration required on an already-existing volume — same caveat as
`research-workflow.md`'s original migration step):

- `documents` — one row per ingested/researched thing (`kind`:
  `reference` | `research`; `source_type`: `pdf` | `url` | `text` |
  `web_research`; `domain`, `metadata` JSONB, `status`).
- `sources` — first-class provenance, one document can span several.
- `chunks` — `embedding VECTOR(768)` (matches `nomic-embed-text`) +
  `content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english',
  content)) STORED`, plus `heading`/`page_number`/`section_path` per chunk.
- `research_sessions` / `findings` / `citations` — persistent research
  runs, with `citations.supports = false` recording a source that
  *contradicts* a finding rather than just dropping it.
- `knowledge_log` — append-only, and actually written to (unlike the old
  pipeline's `research_log`).

`postgres/init/09-add-domain-skills-table.sql` adds `domain_skills`
(source-priority ordering, freshness requirement, per-domain version
field) — see Phase 5 below.

## Build, phase by phase

**Phase 0 — scaffolding + schema.** Copied `event-bus/`'s exact shape
(`config.ts`'s `loadConfig(env)` pattern, `db.ts`'s lazy-singleton `pg.Pool`,
3-stage Dockerfile, Node's built-in test runner via `tsx`). Checkpoint
passed: `docker compose up -d knowledge-engine` connected to the DB and
saw the new tables; `npm test` ran on a placeholder.

**Phase 1a — ingestion + storage skeleton (text/URL).** New
`lib/ollama-embeddings.ts` (no reusable embedding client existed anywhere
in this codebase before this) calling Ollama's `/api/embed`, confirmed
batch-capable against the real running instance. `lib/html-extract.ts`
(Readability + jsdom) strips a URL to readable text. `engine/ingest.ts`
chunks at ~1000 chars, embeds, and inserts `documents`/`sources`/`chunks`.
**Checkpoint passed**: ingested 2-3 real short web pages on one topic,
searched, confirmed every chunk's `source_id` traced back to the correct
page — the direct fix for "no per-chunk attribution" in the old pipeline.

**Phase 1b — PDF ingestion + structural metadata.** `lib/pdf-extract.ts`
uses `pdf-parse` v2's `getText()`, which returns real per-page text and
page numbers natively (`{pages: [{num, text}], text, total}`) — simpler
than the per-page-callback approach originally planned. Heading/section
detection is deterministic regex (`detect-heading.ts`), not an LLM call.
**A real bug found via the actual sourced test PDF (a Bitcoin whitepaper
PDF, since a real Porsche/Warframe document wasn't in hand yet)**: the
numbered-section regex required whitespace immediately after the digit
group, so real headings like "2. Transactions" (digit, period, *then*
space) never matched — fixed by making the period optional
(`\.?`) before the required whitespace, confirmed via a regression test in
`detect-heading.test.ts`. New `scripts/ingest-document.mjs` CLI, mirroring
`scripts/start-coding-task.mjs`'s role as a reference client (no
file-upload path exists in `chat-ui`).

**Phase 1c — hybrid retrieval.** `engine/search.ts` combines pgvector
cosine similarity and Postgres full-text (`ts_rank` on `content_tsv`) via
**Reciprocal Rank Fusion** (`SUM(1.0 / (k + rank))`, `k=60`) rather than
weighting raw scores — cosine distance and `ts_rank` live on incompatible
scales, and RRF sidesteps that by fusing on rank position instead. Metadata
filters (`domain`, arbitrary key/value) are a hard `WHERE` pre-filter.
**A real bug**: `node-pg` returns a `SUM(...)` aggregate as a JS string,
not a number, which silently broke `topResult.score.toFixed()` downstream
— fixed with an explicit `Number()` conversion at the query boundary in
`db.ts`'s `hybridSearchChunks`. **Checkpoint passed**: against the real
ingested PDF, hybrid retrieval was compared side-by-side with pure-vector
search on a real plausible question and confirmed to help before being
trusted.

**Phase 1d — citations as first-class objects.** `/search`'s response
shape is `{ content, documentTitle, domain, pageNumber, sectionPath,
source: { url, title } }` per result, not a flat URL list on the whole
document (the old pipeline's exact limitation). Spot-checked several
returned citations by hand against the real source PDF.

**Phase 2 — web research + deterministic router.** `lib/tavily.ts`
duplicated from `skills-mcp` (small per-service clients, not a shared
package — matches `coding-orchestrator/src/ollama.ts`'s precedent).
`engine/router.ts`'s `decideRoute()` is **deterministic, not an LLM call**:
it checks the knowledge base first via hybrid search, and only escalates
to a live Tavily web search if the top result's RRF score is below
`KNOWLEDGE_ROUTE_TO_WEB_THRESHOLD` (`.env.example`, default `0.02`, chosen
from real observed scores — a genuinely relevant top result scored ~0.03
in testing, a weak/tangential one ~0.015-0.016) or the domain has zero
chunks. This deliberately avoids adding a new LLM-based routing decision,
given this project's own documented, repeated qwen3:8b tool-selection
reliability failures (see [`docs/chat-workflow.md`](chat-workflow.md)).
The routing decision is surfaced in the response (`route: {source,
reason}`) for debuggability. **Checkpoint passed**: one question well
covered by the ingested PDF stayed in `knowledge` (no web escalation), one
clearly outside it escalated to `web` — verified via the response's own
routing metadata, not just answer plausibility.

**Phase 3 — real research agent.** `engine/research-agent.ts` runs a real
tool-calling loop directly against Ollama's native `/api/chat` `tools`
API — the same proven pattern as `coding-orchestrator/src/agent-loop.ts`,
not n8n's LangChain AI Agent/MCP Client Tool node, which sidesteps the
documented tool-name-segment-length and empty-output failure modes by
construction (see the dated entries in
[`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md)). Four tools:
`search_knowledge`, `web_search`, `fetch_page`, `record_finding`. This
replaces the old pipeline's fragile "reply ends with a `SOURCES:` block,
regex-parsed" pattern with structured incremental tool calls. Contradiction
detection: deterministic keyword-overlap clustering
(`engine/cluster-findings.ts`, union-find) groups findings on the same
sub-question, then one dedicated LLM call per cluster (`engine/verify.ts`)
judges agreement/disagreement — same shape as `skill_gap_scanner`'s proven
semantic-dedup check (a narrow, single-purpose LLM judgment call where
string-matching can't do the job). **Two real bugs found via testing**:
clustering initially merged unrelated findings that all happened to share
the literal search topic as a keyword (e.g. everything about "farming
Kuva" clustered together purely because they all said "Kuva") — fixed by
excluding the topic's own words from the significant-keyword set. A
synchronous `POST /research` design was self-flagged as too slow for a
real agent run (60+ seconds) before it ever shipped — split into
`checkKnowledge()` (fast, synchronous) and
`runWebResearchAndPersist()` (slow, detached background task), matching
n8n's `responseMode: onReceived` fire-and-forget pattern.

**Phase 4 — persistent research sessions.** `research_sessions`/
`findings`/`citations` populated for real; a successful run auto-saves
synthesized findings as a `documents` row (`kind='research'`). `GET
/research/:id` returns full session detail. **A real routing bug**: Express
matched `/research/status` as `/research/:id` with `id="status"` because
the parameterized route was registered first — fixed by registering the
literal `/research/status` route before `/research/:id`.

**Phase 5 — domain skills as DB config.** `domain_skills` table, edited via
direct SQL — same convention as hand-editing the `personas`/`skills` Data
Tables today, no YAML and no admin UI. `engine/domain-skills.ts` resolves
one row per request; `search()`/`router.ts` take the resolved policy as a
parameter, so there are zero per-domain branches in the engine itself.
**Honest limitation, not fixed further**: attempts to demonstrate a full
ranking-order *flip* between two domains with different
`freshness_required` settings didn't succeed across four tries — the
underlying `recency_ranked` CTE ordering was verified correct in
isolation, and the score-shift is real, but RRF is deliberately robust
against one dissenting signal once two others already agree by tie-break.
Documented as an accepted property of RRF, not a bug.

## `skills-mcp` cutover

Deleted `tools/research-task.ts`, `tools/research-task-status.ts`,
`tools/research-search.ts`, `lib/research-workflow.ts`. Added
`lib/knowledge-engine-client.ts` (direct-fetch, mirrors
`lib/event-bus-workflow.ts`'s pattern — no n8n proxy hop, matching
`goal_manage`'s precedent) plus two new tools, `knowledge_search` and
`knowledge_ingest` (URL only — local-file ingestion stays CLI-only via
`scripts/ingest-document.mjs`, since no upload channel exists in
`chat-ui`). `research_task`/`research_task_status` keep their tool names
but now call `knowledge-engine` directly instead of an n8n webhook.
`knowledgeEngineUrl` is always-on required infra in `skills-mcp/src/
config.ts` (same tier as `sandboxRunnerUrl`/`eventBusUrl`) — no
"not configured" degradation path, since there's no reasonable
partially-working state for a tool whose entire job is calling this
service.

## n8n rewiring

**Chat workflow** (`n8n/workflows/9YdYYhVGfsKgj4yz.json`): the old single
`research` tool group (`research_task`, `research_task_status`,
`research_search`) split into two — `knowledge` (`knowledge_search`,
`knowledge_ingest`) and `research` (`research_task`,
`research_task_status`) — in both the `Classify Relevant Tool Groups`
node's category enum/description and the `Expand Groups To Tools` node's
`GROUPS` object.

**A stale reference found and fixed during the rewiring, not caught by the
tool-group split alone**: the Chat workflow's "search retry nudge"
mechanism (`Detect Unfulfilled Search Intent`, which force-retries a turn
where the model said "let me search..." but never actually called a
tool) hardcoded `research_search` — a tool that no longer exists — in
both its own retry-eligibility check and the `AI Agent` node's
retry-instruction text ("actually call `web_search` or `research_search`
again"). Left as-is, this would have silently stopped triggering for any
knowledge-type search intent (the array check can never match a tool name
that's never emitted again) and told the model to call a deleted tool on
the rare case it did fire. Found by grepping the whole workflow file for
`research_search` after the group-split edit, not by the reliability test
itself — the test only proves the *new* tools work, not that every old
reference to the *removed* one was caught. Fixed by replacing both with
`knowledge_search` (the direct analog: both are synchronous
search-and-return operations, unlike the fire-and-forget `research_task`).
Re-verified after this second fix: a fresh restart, then the same
"knowledge" test message again, confirmed `knowledge_search` still fires
correctly.

**`skill_gap_scanner`** (`n8n/workflows/skillgapscan001x.json`): its
`Submit Research Task` node now POSTs directly to
`http://knowledge-engine:3005/research` with `{ query, triggerSource }`
(renamed from `topic` to `query` to match knowledge-engine's schema),
instead of the old `research-task` n8n webhook — same direct-call pattern
`calendarwatch0001`/`goalsstalenudge1`/`idlereflection0001` already use
against `event-bus`.

**Verified live (2026-09-18), the same reliability checkpoint already
used for `spotify_control`/`web_search`**: after publishing both workflows
and restarting n8n, sent three real chat messages through the live
webhook via `scripts/chat.mjs`. A "search what you already know about the
Bitcoin whitepaper's block time" message correctly classified into the
`knowledge` group and called `knowledge_search` (confirmed via the
execution's own data, not just the reply text). A "do in-depth research on
the current best Warframe for solo eidolon hunting and remember it"
message correctly classified into `research` and called `research_task`
— a real `research_sessions` row was created
(`trigger_source: 'chat'`), the background agent ran (search_knowledge →
web_search → 5 `fetch_page` calls against Reddit/forum/YouTube pages),
and — the direct verification that the "keep the promise" fix in
`notify.ts` actually works end-to-end — a real completion message
("Finished researching ... but didn't turn up anything concrete enough to
record.") landed in `n8n_chat_histories` once the run finished, without
the fetched pages yielding any recordable text (Reddit/forum/YouTube pages
aren't reliably scrapable via Readability — a real content-extraction
limitation of `fetch_page`, not a routing or notify bug). A control
message ("what's the weather in Tokyo") confirmed the unrelated `web`
group still calls `web_search` correctly — the new grouping didn't
regress an existing one. Separately, `skill_gap_scanner`'s exact rewired
request shape (`{query, triggerSource: 'gap_scanner'}` to
`knowledge-engine:3005/research`) was sent directly and confirmed to
create a `research_sessions` row with the correct `trigger_source`.

## Cutover housekeeping

`research_pipeline` (`n8n/workflows/researchpipe1x.json`) was unpublished
and n8n restarted, but — the same `unpublish:workflow` gotcha already
documented for `codingtaskpipe1x` in
[`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md) — its
`research-task`/`research-task-status`/`research-search` rows in
`webhook_entity` survived the unpublish and restart. Deleted those three
rows directly (`DELETE FROM webhook_entity WHERE "workflowId" =
'researchpipe1x'`) so no future workflow conflicts if those paths are ever
reused; the workflow file itself is kept in `n8n/workflows/` as a rollback
reference, never deleted, matching `codingtaskpipe1x`'s treatment.

## 2026-09-18 — dogfooded with a real document, found and fixed a real routing miscalibration

Every prior checkpoint above was verified against small throwaway test
fixtures (a Bitcoin whitepaper PDF, single short web pages). This closes
the loop on the system's actual motivating use case: ingested two real
documents — the 2007-08 Porsche Cayman (987) Quick Reference Guide (3
chunks) and the full Cayman/Cayman S (987) Owner's Manual (283 chunks,
500+ real pages) — via `scripts/ingest-document.mjs`, run from inside the
`knowledge-engine` container itself (it has no published port; copied the
downloaded PDFs and the script in via `docker compose cp`).

**Verified correct against the real manual**: page numbers landed exactly
on the manual's own printed page numbers (e.g. the "6 Table of Contents"
heading on PDF page 8, matching the document's real front-matter offset);
142 of 283 chunks got a real detected heading. A real query ("how do I
bleed the Porsche Ceramic Composite Brakes") returned the manual's actual
Brake Fluid Level section (page 194) with correct cross-references to
other real pages the manual itself points to (56, 186) — the first time
this was checked against genuine multi-hundred-page structured content
rather than a single test PDF.

**A real, quantified problem found**: asking `/research` "what type of
brake fluid does the Porsche Cayman need" — a question the manual directly
answers — escalated to a live web search anyway. The router's
`KNOWLEDGE_ROUTE_TO_WEB_THRESHOLD` (0.02, chosen in Phase 2 from a single
small test document) turned out not to generalize: with the real
286-chunk two-document corpus, even the genuinely correct top match (the
manual's own Brake Fluid Level section) scored only 0.0164 — all 5 of the
top results for that query clustered tightly at 0.0154-0.0164, confirming
this wasn't a one-off scoring fluke. RRF scores compress as the corpus
grows (more chunks compete for rank position), so a threshold tuned
against one document doesn't hold once real content accumulates. The
resulting wasted web search independently re-derived the *exact same
fact* already sitting in the manual (`0.4 quarts/0.39 liters ... Original
Porsche brake fluid` — both the manual and the live web agent landed on
identical wording), which is about as direct a demonstration of wasted
work as this could produce.

**Fixed**: retuned `KNOWLEDGE_ROUTE_TO_WEB_THRESHOLD` from `0.02` to
`0.012` (both the `config.ts` code default and `.env.example`'s
documented default), based on today's real observed scores rather than
Phase 2's single-document test. Re-verified the identical query
immediately after rebuilding: `route.source` correctly stayed
`"knowledge"` (`"top knowledge-base match scored 0.0164, met the 0.012
threshold"`), and the top result surfaced an even more precise answer
than the earlier web search had found — the manual's own Technical Data
capacities table ("Brake fluid: approx. 0.4 quarts/0.39 liters; use only
Original Porsche brake fluid"). **This threshold is confirmed to still
need retuning as more domains/documents get added** — it's a real,
evolving property of RRF against a growing corpus, not a one-time
constant to set and forget.

## 2026-09-19 — a deterministic lexical-overlap gate, since RRF score alone can't tell a real match from a coincidence

Real chat testing after the two fixes above (dogfooding + `research_task`'s
false-positive fix) surfaced the actual root cause underneath both: even
after `research_task` started returning real content inline and the
retry-nudge correctly forced a second attempt, a rephrased "Nissan GT-R
successor rumors" query *still* routed to "knowledge" both times. Traced
to `hybridSearchChunks()`'s `vector_ranked` CTE (`db.ts`): it always
returns the top-K nearest neighbors by cosine distance with no relevance
floor, so within a domain-filtered candidate pool *something* always
ranks top-3 and gets folded into a similar RRF sum — regardless of true
relevance. No threshold number can separate a genuine match from an
unrelated same-domain "best of a bad bunch," because they occupy the same
numeric range by construction (both the real brake-fluid match and the
unrelated GT-R/PSM coincidence scored ~0.0164).

**Fixed** with a second, independent, deterministic gate: `decideRoute()`
now also requires the top result to share at least
`config.minKeywordOverlap` (default 1) real, non-trivial (`length >= 3`)
lexemes with the query — computed via a new `query_lexemes` CTE in
`hybridSearchChunks()`, using the same `to_tsvector('english', ...)`
stemming/stopword-removal `content_tsv` is already built with, so
"bleeding" vs "bleed" etc. line up without custom normalization.
Deliberately *not* reusing `keyword_ranked`'s existing full
`plainto_tsquery` AND-match as the gate — that would be too strict and
reject genuine vector-only natural-language matches (the real "bleed the
PCCB" question doesn't literally contain "bleed" in the manual's correct
Brake Fluid Level passage). A floor of 1 shared lexeme is the deliberate
middle ground: strict enough to reject "Nissan GT-R" (shares zero lexemes
with the unrelated Porsche Stability Management passage it was
matching), permissive enough to keep "bleed the PCCB" correctly routed to
knowledge (shares "brake" with the real match). If the query itself
reduces to zero significant lexemes (all-stopword/degenerate), the gate
is skipped entirely and pure RRF-threshold behavior applies — there's no
real signal to check in that case. `pg_trgm` was considered and confirmed
not installed (checked every `postgres/init/*.sql` file directly) so this
is built entirely from core Postgres tsearch functions, no new extension.

**Known, accepted trade-off**: a genuinely relevant chunk that's a pure
paraphrase sharing zero stemmed lexemes with the query (e.g. query says
"horsepower," chunk only says "PS") is now a new false negative. Inherent
to any deterministic lexical gate layered on embeddings — mitigated by
keeping the floor as low as 1 shared lexeme, not fixable further without
reintroducing an LLM judgment call at this decision point (explicitly out
of scope, same reasoning as `router.ts`'s original no-LLM comment).

**Verified live**, re-running the exact real queries from the prior
dogfooding + `research_task` sessions against the same two-document
Porsche corpus: "how do I bleed the Porsche Ceramic Composite Brakes" and
"what type of brake fluid does the Porsche Cayman need" both correctly
stayed `route.source: "knowledge"` (unaffected by the new gate). "Nissan
GT-R successor rumors" now correctly returns `route.source: "web"`, with
`route.reason` explicitly citing the overlap gate ("shared only 0
keyword(s) with the query (need 1) - likely a vector-similarity
coincidence, not a real match") rather than the score, since the RRF
score itself (~0.0164) was still above threshold. A real chat message
reproducing the original bug end-to-end ("do some in-depth research on
the upcoming Nissan GT-R successor rumors") triggered a genuine web
escalation, a real multi-source research run (findings cross-verified as
`confirmed` against real citations from thedrive.com and
caranddriver.com), and persisted a real document — a second identical
chat message afterward then correctly recalled that real, now-existing
knowledge instead of escalating again, confirming the full
research-once-then-recall loop works end-to-end with a genuinely novel
topic. All test data (the throwaway GT-R research session and document)
was cleaned up afterward; the two real Cayman documents from the earlier
dogfooding round were kept.

## 2026-09-22 — self-learning research queue: ambient knowledge-gap detection, drained during idle/overnight time

**Real gap found via live testing**: the user said "I have a new project
idea of building a robotics arm." Amy did nothing with it — not tracked as
a goal, not recognized as a topic worth researching. The user's own
framing: *"anything it is iffy about needs to be researched on offline
times."* Rather than building new research/notify machinery, this reuses
three already-proven pieces verbatim: `checkKnowledge`/
`runWebResearchAndPersist` (this file's own Phase 2/3 pipeline) do the
actual research; `event-bus`'s calendar wake-event trigger
(`calendar-watch.ts`'s `isWakeEvent`) is the existing idle/awake signal;
`deferNotify`/`logAwaitingDigest`/`runOvernightDigest` already folds
background completions into one consolidated Discord message. See
[`docs/event-bus-and-goals.md`](event-bus-and-goals.md) for the drain
trigger's own side.

**New table `research_queue`** (`postgres/init/16-create-research-queue-table.sql`,
same `research` database, co-located with `research_sessions` since a
queue row graduates directly into one): `topic`, `domain`,
`origin_session_id`, `trigger_source`, `status`
(`pending`/`researching`/`done`/`failed`), `research_session_id`. Generated
`topic_tsv` + GIN index reuses `hybridSearchChunks()`'s `query_lexemes`
lexeme-overlap technique for dedup, rather than a second embedding-similarity
codepath — topic strings are short enough that this is cheaper and
sufficient.

**`engine/research-queue.ts`**:
- `enqueueTopic(config, {topic, domain?, originSessionId?, triggerSource?})`
  — dedup gate, cheapest-first: (1) exact case-insensitive match against
  pending/researching rows; (2) lexeme-overlap ≥
  `RESEARCH_QUEUE_DEDUP_MIN_OVERLAP` (default 2, higher than document
  search's default of 1 since topic strings are short and generic); (3)
  `checkKnowledge()` — if already well covered, skip entirely, nothing to
  queue (verified live: a Porsche-brake-fluid-style query correctly
  returned `"already known: top knowledge-base match scored 0.0164, met
  the 0.012 threshold"` without ever reaching the table); (4) a max-pending
  cap (`RESEARCH_QUEUE_MAX_PENDING`, default 50) — rejects rather than
  evicts, since a full queue means the drain rate needs attention, not
  silent data loss.
- `drainQueue(config, limit)` — claims up to `limit` oldest `pending` rows
  atomically (`UPDATE ... WHERE id IN (SELECT ...)`), then **sequentially**
  (not parallel, to bound Ollama load) runs each through the same
  `checkKnowledge` → `insertResearchSession` → `runWebResearchAndPersist`
  path `POST /research`'s handler already uses, with `deferNotify: true`
  and `triggerSource: 'research_queue'`.

**New routes**: `POST /research-queue` (enqueue), `GET /research-queue?status=`
(list, debugging/ops only — no chat-invoked tool wraps this yet), `POST
/research-queue/drain` (the real drain, also a manual test entry point).

**Two independent write paths, deliberately not just one**:
1. **Ambient, classifier-driven** (`chat-orchestrator`'s Coordinator —
   see [`docs/chat-orchestrator.md`](chat-orchestrator.md)): the
   classification call that already runs every turn gained
   `knowledgeGapTopic: string | null`, fire-and-forget enqueued when
   non-null. No new LLM call.
2. **Deterministic backstop** (`event-bus`'s `POST /goals` — see
   [`docs/event-bus-and-goals.md`](event-bus-and-goals.md)): every newly
   created goal unconditionally seeds a queue entry from its title,
   `triggerSource: 'goal_created'`, independent of whether the classifier
   caught the moment.

**No human-approval gate**, unlike `skill_gap_scanner`'s proposal table
(the closest existing precedent for "something autonomous decides X is
worth doing"). That flow requires a human to flip a Data Table row to
`active` because *acting* on a skill proposal has real consequences
(system-prompt injection or new code). Queuing/running background research
is comparatively low-stakes and reversible — it only enriches the
knowledge base — so this goes straight from queued to auto-drained.

**Verified live end-to-end (2026-09-22)**, real data, not synthetic
fixtures: "I have a new project idea, I want to build a robotics arm" sent
through live `chat-orchestrator` correctly created goal #16 ("Build a
robotic arm") **and** queued `"robotics arm design and construction"`
(`trigger_source: chat`). A second real message ("I want to build a
submarine") queued `"Build a submarine"` via the `goal_created` backstop
even though the classifier itself didn't set `knowledgeGapTopic` that
turn — confirming the two paths genuinely cover for each other. Manually
draining both (gated on work level, same check `/idle-reflection-check`
already uses) ran two real multi-source research agent loops end to end:
both `research_sessions` rows landed `status: 'complete'`, 9 real
`findings` each (confirmed confidence — e.g. real claims about kinematic
chains, degrees of freedom, servo motor control), both correctly deferred
into `events` as `research_completed_awaiting_digest` rather than an
immediate Discord ping, and both `research_queue` rows flipped to `done`
with `research_session_id` populated. Exact-match and lexeme-overlap dedup
both independently verified against the live queue afterward.

**Real bug found immediately after shipping, via live testing**: asking
"what's the progress on the robotic arm" (research from the example above)
returned "No research task found for this conversation" even though the
research had genuinely completed with real findings. Root cause:
`research_task_status` only ever checked for a `research_sessions` row
tied to the *current* chat session id — but ambient/queue-driven research
is deliberately decoupled from any specific conversation, queued in one
session and possibly drained hours/overnight later from a different or
later one. **Fixed**: `research_task_status` gained an optional `topic`
parameter; `GET /research/status` now accepts `?topic=` as an alternative
to `?sessionId=`, checking `research_queue` first (any status, most recent
lexeme-overlap match — same technique as the queue's own dedup), falling
back to `research_sessions` directly for anything researched via the older
`research_task` path. A completed match includes its findings inline, so
"what did you find out" is answered in one tool call. Verified live: the
same "robotic arm" query that previously returned "not found" now
correctly returns the real session (`status: complete`, all 9 findings
with citations).

## Not built yet

- Reranking (a cross-encoder model) — deferred until hybrid retrieval is
  proven insufficient against real usage; Ollama doesn't natively serve
  rerank models, this would need a new service or a paid API.
- A knowledge graph — explicitly deferred (Phase 6 in the original plan).
  Concrete revisit trigger: a recurring *real* query pattern needing
  genuine many-to-many structured relationships a flat metadata-filtered
  chunk table can't represent, not a hypothetical one.
- Automated tests beyond the pure/deterministic pieces (`chunk-text`,
  `detect-heading`, `cluster-findings`, `router`, `config` — 29 tests
  total via Node's built-in test runner). The agent loop, ingestion
  pipeline, and hybrid search itself are verified live only, same
  "manual/live testing against the real stack" caveat the README notes
  for `coding-orchestrator`/`sandbox-runner`/`skills-mcp`.
- `fetch_page`'s reliability against JS-heavy pages (Reddit, forums,
  YouTube) — observed directly during the n8n-rewiring verification above.
  A real research question can legitimately end in zero findings if every
  source the agent tries happens to be one of these, which is an honest
  "nothing concrete enough to record" outcome, not silently making
  something up — but a Readability-only extractor is a real ceiling worth
  knowing about.
- Research-queue per-session/per-day enqueue rate limiting — not built
  until real usage shows the classifier's `knowledgeGapTopic` field
  producing a genuine false-positive spam problem, not speculatively.
- A chat-invoked tool to list/manage the research queue directly —
  `GET /research-queue` exists for debugging/ops from day one; no MCP tool
  wraps it until real usage shows people want to inspect/cancel queued
  topics themselves.

## 2026-09-22 — `projects`: proposed/approved learning projects that consolidate into knowledge

Follow-up to the home dashboard (`docs/chat-ui.md`'s 2026-09-22 entry) and
the self-learning research queue above: a new `/amy` dashboard page where
Amy can propose a bounded research "project," a human approves it, it runs
through the existing `research_queue` drain unchanged, and — the actual
point — finishing it **consolidates the findings into a real write-up**,
not just structured findings/citations rows.

**Why a new `projects` table instead of reusing `task_contexts`**: open
task_contexts are injected into *every chat turn's prompt* unconditionally
(chat-orchestrator's `getOpenTaskContexts`), with no kind-based filter to
retrofit safely — a proposed/active learning project sitting there would
silently bloat every turn. `projects` (`postgres/init/17-create-projects-table.sql`,
`research` DB) is a dedicated table instead, with real foreign keys to
`research_queue`/`research_sessions`/`documents` since it's colocated in
the same database — the approve step enqueues a research_queue topic
in-process, no cross-service HTTP hop needed.

**v1 deliberately does not build a second autonomous agent**: approving a
project just calls the existing `enqueueTopic()` (`engine/research-queue.ts`)
with the project's title, and the existing overnight drain
(`POST /calendar/poll-check` → `drainResearchQueueIfIdle`, unchanged) does
the actual work. A project is a human-approved wrapper around one research
topic, not a new execution engine — broader autonomous "go build
something" work is a later phase once this narrower loop is proven.

**Consolidation is the new piece**: no function anywhere in this codebase
turned raw notes/findings into a narrative write-up before this — confirmed
via grep; `persistResearch()` only ever inserted structured findings/
citations, and `documents.markdown` (commented "present for 'research'
kind (synthesized doc)") was set nowhere. New `engine/consolidate.ts`'s
`consolidateProject()` reads the linked research session's findings via
the existing `getResearchSessionDetail`, makes one `ollamaChat()` call to
synthesize markdown, and writes it onto the **existing** document already
referenced by `research_sessions.document_id` (not a new document row) via
new `db.setDocumentMarkdown()`. Triggered by `POST /projects/:id/complete`
— kept synchronous (the dashboard button waits on one bounded LLM call)
rather than the async `deferNotify`+digest pattern, which exists to batch
unrelated *background* completions and is a poor fit for "user just
clicked a button and is watching."

`getResearchSessionDetail`'s result gained a `documentMarkdown` field so
`chat-ui`'s `/research/[id]` page (already built for plain research
write-ups) can render the consolidated write-up above its findings list —
otherwise consolidation would produce a write-up nobody could actually
read anywhere.

**New MCP tool**: `project_propose` (skills-mcp), modeled on
`skill_propose`'s registration shape but posting directly to
knowledge-engine's `POST /projects` (REST, not an n8n webhook/Data Table)
— unlike `skill_propose`, which is approved by a human manually flipping a
status field in an n8n Data Table (the only prior approval-gated pattern
in this codebase, with no in-app approve action anywhere), projects get a
real approve/reject button on `/amy`. Bound to the Coordinator's existing
`goals` tool group (`chat-orchestrator/src/classify-tools.ts`) alongside
`goal_manage`, since the trigger scenario is the same one that widened
that category's description in the research-queue work ("I have a new
project idea, I want to build a robotics arm") — the tool's own
description disambiguates it from both `goal_manage` (tracks an ongoing
objective, does no work) and `skill_propose` (a new capability for Amy
herself, not research for the user). Also added to `safety-net.ts`'s
`ACTION_TOOLS` (a real side-effecting tool, same confabulation-detection
reasoning as `research_task`/`skill_propose`).

**Explicitly deferred** (see the plan this was built from): idle-reflection-
driven *automatic* project proposals (v1 only proposes mid-conversation via
the tool call above); non-research project execution (v1 is "human-approved
research" only); a `project_log` table for manual notes (the substantive
work product is the linked research session's findings, not hand-written
log text — cut as dead weight rather than built unused).

**Verified live, end to end, with real data**: proposed a test project via
direct `POST /projects`; it rendered on `/amy` with working Approve/Reject;
approved it — a real `research_queue` row was created
(`trigger_source='project_approved'`) and the project flipped to `active`;
drained the queue — the linked research_queue row reached `done` with a
real `research_session_id`; clicked "Mark done" (`POST /projects/:id/complete`)
— the existing document's `markdown` column was populated with a real,
coherent Ollama-synthesized write-up, `/research/{id}` rendered it above
the findings list, and the project reached `status='done'` with
`document_id` set.

## 2026-09-23 — `projects` gains `activity_type`: coding, not just research

Direct follow-up to the projects feature above. The user asked to also see
and actually use the existing coding agent (`coding-orchestrator` - a real
Planner/Coder/Tester/Reviewer loop in an isolated sandbox, previously only
reachable via `code_task`'s immediate, ungated, direct-in-chat path) as a
second kind of thing a project can wrap - the "second real instance" the
research-only design deliberately waited for before generalizing.

`projects` gained `activity_type` ('research' | 'coding'), `coding_task_id`
(opaque - `coding_tasks` lives in a separate database, no FK, resolved via
`GET /tasks/:id`) and `target_repo_url` (`postgres/init/18-add-project-activity-type.sql`).
`POST /projects/:id/approve` and `POST /projects/:id/complete` both branch
on `activity_type`; the coding branch calls `coding-orchestrator` **directly**
(new `lib/coding-orchestrator-client.ts`), not through the old n8n webhook
shim `code_task` still uses - a new caller straight into the same service,
consistent with this project's ongoing direction of retiring n8n
intermediary hops rather than adding a second one onto an old shim.

**A real naming collision, not a bug**: `coding_tasks.status` already uses
the value `'proposed'` for something different from `projects.status='proposed'`
- it means "Reviewer approved, tests passed, diff/PR ready for a human to
review the code" (a terminal success state, `coding-orchestrator/src/pipeline.ts`'s
`finalizeTask`), not "awaiting a human's decision to even start." Both
pre-existing/load-bearing where they already live; not renamed, just kept
distinct as `coding_task_status` next to `project.status` (same convention
`research_queue_status` already established).

**`consolidateProject` now branches too** (`engine/consolidate.ts`): the
research path is unchanged (updates the *existing* document already tied
to `research_sessions.document_id`). The coding path is genuinely
different - there's no pre-existing document for a coding task, so it
creates one (`insertDocument({kind:'project', sourceType:'coding_task'})`),
synthesizing from the task's `task_description`/`diff`/`test_output`/
`reviewer_reason`/`pr_url` (diff/test output capped in the prompt - one
bounded synthesis call, not a multi-step run) rather than research findings.

**Small robustness fix applied to both branches while touching this code**:
`/projects/:id/complete` previously treated a *failed* research_queue entry
identically to "still researching" (`status !== 'done'` → generic "research
not finished yet" 409, forever, for a permanently failed topic). Both
branches now distinguish a real terminal failure from "still in progress"
and surface the actual reason (`reviewer_reason`/`latest_status` for
coding, a distinct message for a failed research queue entry).

**Verified live, end to end, with real data**: proposed a coding-activity
project directly; it rendered correctly via the real `/amy` API path;
approved it - a real `coding_tasks` row was created (`POST /task` fired
directly, no n8n hop) and the pipeline actually ran through all 3 real
attempts; it reached a genuine terminal failure
(`needs_review_failed` - the Tester ran out of iterations); confirmed
`/projects/:id/complete` correctly surfaced the real reviewer reason
instead of a generic "not finished yet." The success path (consolidation
producing a new document) is implemented the same way the already-verified
research path is, but wasn't independently exercised this pass - this
specific test task happened to fail for real, unrelated reasons (the same
kind of failure several pre-existing real coding_tasks rows already show).
