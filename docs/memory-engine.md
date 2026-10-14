# `memory-engine` — self-hosted cross-conversation memory, no LLM in the hot path

Part of the [Smart Assistant](../README.md) project. See
[`docs/chat-orchestrator.md`](chat-orchestrator.md)'s Coordinator section
(Phases 3/3b) for how this service is wired into a live chat turn, and
[`docs/honcho-memory.md`](honcho-memory.md) for what Honcho still owns
(peer-card profile summaries) versus what moved here.

**2026-09 — built because the only path to "remember something from a
different conversation" was Honcho's hosted dialectic API**, called ad hoc
by the `memory_recall` tool — unreliable by construction, since it only
fires when the model decides to call it, and ties this specific capability
to a third-party host. Folding it into `knowledge-engine` instead was
rejected: that service's own docs already draw a deliberate line that user
memory is out of scope there (mixing personal conversation data into the
world-facts store would blur a domain boundary this project has kept
clean everywhere else). `memory-engine` is a new, small, dedicated service
— same shape as `event-bus`/`knowledge-engine` — that owns exactly this:
storing every turn and answering "what have I said about X before,"
deterministically ranked.

## Architecture

New service, `memory-engine/` (Node/Express/pg, internal-only on
`assistant-net`, no published port). New Postgres database `memory` (same
shared instance, same one-database-per-concern convention as
`n8n`/`research`/`coding_tasks`/`events`).

`postgres/init/13-create-memory-db.sql` creates the database and
`memory_entries` table: `id, session_id, role (user/assistant), content,
embedding VECTOR(768), content_tsv TSVECTOR GENERATED ALWAYS AS
(to_tsvector('english', content)) STORED, created_at`. Same HNSW-cosine
index on `embedding` and GIN index on `content_tsv` as knowledge-engine's
proven `chunks` table — copied directly, already proven at this project's
scale. `postgres/init/15-add-memory-metadata-columns.sql` (Phase 3b) added
`domain` and `task_context_id` columns so retrieval can optionally scope
to one topic or one open task's own history.

**Embedding**: `src/lib/ollama-embeddings.ts` duplicates
`knowledge-engine/src/lib/ollama-embeddings.ts`'s `embedText()`/
`embedTexts()` verbatim (pure, table-agnostic, `nomic-embed-text` via
Ollama's batch `/api/embed`) — same small-per-service-duplication
convention this project already uses elsewhere (`event-bus/src/notify.ts`,
`knowledge-engine`'s own duplicated `lib/tavily.ts`). No chunking — a chat
turn is well under the length where knowledge-engine's own chunker would
even split, so each turn is embedded whole as one row.

**`POST /ingest`**: `{sessionId, role, content, domain?, taskContextId?}`
→ embed, insert one row. Called by `chat-orchestrator` after every turn
(both the user's message and Amy's own reply, so retrieval later includes
what Amy said too), fire-and-forget — doesn't block the response. No
extraction or should-save gating: every turn is stored unconditionally,
a deterministic write path with no LLM judgment call (see below).

**`POST /search`**: `{query, topK?, domain?, taskContextId?}` →
`{results: [...]}`. `db.ts`'s `hybridSearchMemory` mirrors
knowledge-engine's proven `hybridSearchChunks()` RRF pattern (`SUM(1.0 /
(60 + rank))`), fusing three ranked lanes: vector-cosine, keyword
(`ts_rank`/`plainto_tsquery`), and — new relative to knowledge-engine's
version — a **recency-ranked lane**, since a recent personal mention is
usually more relevant than an old one in a way that isn't as reliably true
for world-fact retrieval. `domain`/`taskContextId` are optional hard
`WHERE` pre-filters, same convention as knowledge-engine's metadata
filters.

**2026-09-23 — relevance-gating fields added to every result.** A real live
incident (unrelated recency-boosted memory from a past conversation got
injected into a Porsche-automation session and primed four duplicate
`project_propose` retries) showed the recency lane means a completely
unrelated-but-recent memory can still land a nonzero RRF score. Each result
now also carries `keywordOverlapCount`/`queryLexemeCount` (same
`query_lexemes` CTE technique as knowledge-engine's `hybridSearchChunks`),
so `chat-orchestrator`'s `isRelevantMemory` can gate automatic injection on
real keyword overlap in addition to the raw score, not the score alone —
`memory-engine` itself stays policy-agnostic and just exposes the two
numbers.

## No LLM anywhere in this service — deliberate, and reverted from a real build

Phase 3b originally built `src/synthesize.ts` — an LLM call that turned
raw hybrid-search hits into a compact natural-language summary before
returning them from `/search`. **Removed entirely**, per direct user
feedback: *"I don't think llm is needed for this memory engine but it
should be classifications, relevance ranks and such."* Real, measured
cost of keeping it: `memory_recall`'s response time dropped from several
seconds (with synthesis in the loop) to **71ms** (plain ranked results)
once it was cut. This is the standing principle for every future addition
to this service — default to a deterministic or embedding-similarity
substitute before reaching for a model call. (A later refinement pass —
deterministic confidence scoring from frequency/recency/hedge-language
signals, embedding-similarity-based supersession instead of an
LLM contradiction judgment, and an extraction step for raw-turn→distilled-fact
compression — was designed and explicitly **not built**; see Phase 7 in
the architecture plan. Raw hybrid recall already worked in real testing,
and extraction is the one piece that's a genuine, unavoidable judgment
call if it's ever built — not built speculatively ahead of evidence it's
actually needed.)

## Callers

- **`chat-orchestrator`** (`src/memory-engine-client.ts`) — searches on
  every turn whenever `memoryPolicy !== 'none'` (see
  [`docs/chat-orchestrator.md`](chat-orchestrator.md)'s Coordinator
  section), fetched in parallel with the Honcho peer-card fetch, injected
  into the system prompt as its own block, separate from the peer-card's
  general profile summary.
- **`skills-mcp`'s `memory_recall` tool** (`src/lib/memory-engine-client.ts`,
  `src/tools/memory-recall.ts`) — the model-invoked path, for when the
  model explicitly realizes mid-conversation it needs to check something
  specific. Explicitly excludes documents/manuals/guides even when phrased
  possessively ("my manual", "my car's manual") — that's `knowledge_search`
  (`knowledge-engine`), not `memory_recall`, since a manual isn't a fact
  about the user, it's a stored document. This exclusion was added after a
  real live misrouting — see
  [`docs/chat-orchestrator.md`](chat-orchestrator.md)'s bug list.

## Verified live

- Real cross-session test: told Amy something specific and memorable in
  one session, brought it up obliquely in a genuinely separate session,
  confirmed `/search` surfaced the earlier detail without the model
  needing to call `memory_recall` itself.
- `memory_recall` end-to-end latency measured at 71ms after the synthesis
  step was removed (down from several seconds with it in place).
- Domain/manual misrouting fix verified live via Discord: real Porsche
  manual excerpts (seat memory settings, tire pressure, fuel tank
  capacity) returned via `knowledge_search`, not `memory_recall`, after
  the tool-description fix.

## Not built (Phase 7, tabled — not a gap, a deliberate deferral)

- **`should_save` gate** — dropped entirely, not deferred. Storage is
  cheap (text + one embedding); `domain`/`task_context_id` tagging plus
  hybrid RRF ranking already keep retrieval from drowning in noise, so an
  LLM call to decide "is this worth saving" doesn't earn its cost against
  a problem that's already handled downstream.
- **Deterministic confidence scoring** (frequency of restatement, recency,
  stated-fact-vs-hedge keyword check) and **embedding-similarity-based
  supersession** (a new entry's embedding exceeding a similarity threshold
  against an existing one, treated as superseding by recency) — designed,
  not implemented.
- **Extraction** (raw turn → distilled fact) — the one piece that's
  genuinely, unavoidably a judgment call; would be the only LLM call
  anywhere in this service if ever built, and only once raw recall
  demonstrably falls short on something real.

## 2026-10-01 — `grounding` column: tagging a stored memory as verified or not, at write time

Companion fix to knowledge-engine's own deterministic grounding check (see
[`docs/knowledge-engine.md`](knowledge-engine.md)'s entry of the same
date) — same failure shape, different path: a fabricated claim (e.g. a
made-up "Qwen3.8-LiveTranslate API"/WebRTC detail) landing in
`memory_entries` indistinguishable from something the user actually said
or a tool actually verified. `postgres/init/22-add-memory-grounding-column.sql`
adds `memory_entries.grounding TEXT NOT NULL DEFAULT 'ungrounded'` (free-text,
no CHECK constraint, same convention as `findings.confidence`) plus an
index on it.

No new logic in `memory-engine` itself — `POST /ingest` just validates the
caller-supplied `grounding` against an allowlist
(`tool_verified`/`user_stated`/`ungrounded`), defaulting to the
conservative `ungrounded` if omitted or invalid, and returns it on every
`/search` result. The actual classification is deterministic and lives in
the caller: `agent-service`/`chat-orchestrator`'s
`safety_net.classify_memory_grounding` (`role='user'` → `user_stated`;
`role='assistant'` → `tool_verified` only if at least one real tool ran
that turn, else `ungrounded`). `system-prompt.ts`/`system_prompt.py` render
an `ungrounded` memory differently in the injected context block (hedged
phrasing) than a verified one — see
[`docs/chat-orchestrator.md`](chat-orchestrator.md).

## 2026-10-11 — ids/counts now cross the API as real numbers, not strings

Same fix as `knowledge-engine`/`event-bus` (see
[`docs/knowledge-engine.md`](knowledge-engine.md)'s entry of the same
date): `node-pg` returns `BIGINT` (OID 20) as a string by default, and
every id here is a BIGINT `IDENTITY` column. New `src/pg-types.ts`
registers a type parser returning a real JS number (throwing past
`2^53`), imported for its side effect in `db.ts`. `hybridSearchMemory`'s
own `SUM(...)` aggregate (`rrf_score`, `NUMERIC`/OID 1700) is unaffected
by this and still needs its existing explicit `Number()` conversion —
BIGINT and NUMERIC are different OIDs with different default behavior.
