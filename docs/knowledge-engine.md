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
