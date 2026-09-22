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
