# Research workflow (topic research, markdown synthesis, RAG recall)

Part of the [Smart Assistant](../README.md) project. See
[`docs/persona-system.md`](persona-system.md) for `web_search` (the
one-shot lookup this builds persistent memory on top of) and
[`docs/skill-gap-scanner.md`](skill-gap-scanner.md) for the autonomous
trigger path.

**2026-07-29 — added because Amy had no way to build persistent knowledge.**
`web_search` (see [`docs/persona-system.md`](persona-system.md)) is a
one-shot lookup with no memory; Honcho only models the user, not arbitrary
subject-matter knowledge. This closes that gap: a background pipeline that
researches a topic across multiple web searches, synthesizes a detailed
markdown document, and stores it so it's recallable later via semantic
search (RAG) — from any conversation, not just the one that started the
research.

**Three trigger paths**, all wired to the same `research_pipeline` n8n
workflow's submit webhook: an explicit ask ("research X and remember it"),
Amy's own proactive judgment mid-conversation (the `research_task` tool's
description doesn't restrict it to explicit requests), and fully
autonomously from `skill_gap_scanner`'s nightly scan (see
[`docs/skill-gap-scanner.md`](skill-gap-scanner.md)) — its `Ollama
Reasoning` node now tags each proposal with a structured `gap_type`
(`capability`/`functionality`/`knowledge`), and a `knowledge`-typed gap that
survives the existing semantic-dedup check (so it only fires once per
genuinely new gap, never on every run) triggers `research_task` directly,
in addition to (not instead of) the existing skill-proposal path.

**Storage: a new, dedicated `research` Postgres database**
(`postgres/init/02-create-research-db.sql`), not a schema inside n8n's own
database — mirrors `n8n` itself being a separate `CREATE DATABASE`. n8n
Data Tables can't hold a `vector` column (only string/number/boolean/date),
so this needed a real SQL table reached via a dedicated n8n Postgres
credential: `research_documents` (topic, title, markdown, source_urls,
status, trigger_source) and `research_chunks` (`embedding VECTOR(768)`,
`hnsw`/cosine index) plus an append-only `research_log`. Since
`postgres-data` already existed as a live volume before this file was
added, `docker-entrypoint-initdb.d` scripts don't auto-apply to it — this
needs the one-time manual migration documented at the top of that SQL file
(`CREATE DATABASE research ...` then piping the rest of the file into
`psql -d research`), same "does not create it for you" caveat as
`CODING_TASKS_REPO_URL`.

**`research_pipeline`** (`n8n/workflows/researchpipe1x.json`) follows
`coding_task_pipeline`'s proven three-webhook shape (see
[`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md)):
`research-task` (POST, fire-and-forget submit — a Research Agent uses
`web_search` repeatedly across different angles, ends its reply with a
`SOURCES:` block that's parsed out deterministically rather than trusted
from prose, then a separate non-agentic Ollama call synthesizes the
findings into a titled markdown document), `research-task-status` (GET,
synchronous poll, same pattern as `code_task_status`), and a new third
one, `research-search` (POST, synchronous RAG query — embeds the query
via `nomic-embed-text`, does a pgvector cosine-similarity search over
`research_chunks`, returns the top matches with their parent document's
title/URLs). A hard failure mid-run routes to marking the row
`status: 'failed'` rather than leaving it stuck at `running` forever — the
coding-agent pipeline hit exactly that failure mode once already (see
[`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md)).

**Three new skills-mcp tools**: `research_task` (submit), `research_task_status`
(session-scoped poll, mirrors `code_task_status`), and `research_search`
(deliberately **not** session-scoped — the whole point of RAG recall is
that research from any past conversation, or from `skill_gap_scanner`
itself, is findable from any other). All three optional, same
config-missing-error-at-call-time pattern as every other integration —
`RESEARCH_TASK_WEBHOOK_URL` / `RESEARCH_TASK_STATUS_WEBHOOK_URL` /
`RESEARCH_SEARCH_WEBHOOK_URL` in `.env.example`.

**Verified live (2026-07-29):** deployed against the existing `postgres-data`
volume (manual migration + a new "Research Postgres account" n8n credential),
all four affected workflows imported/published, n8n restarted, `skills-mcp`
rebuilt. Triggered `research_task` via a real chat turn ("research the health
benefits of green tea") — the document landed with 10 real embedded chunks,
and `research_search` returned genuinely relevant results ranked by
similarity (top match 0.874 on "green tea and weight loss/metabolism"). With
`TAVILY_API_KEY` still unset, the agent correctly left `source_urls` empty
rather than fabricating citations — real graceful degradation, not a crash.
The same deployment also fixed a second, unrelated bug discovered along the
way: `coding_task_pipeline` defaulted every task's test command to `npm
test` regardless of language, so non-Node tasks (e.g. a plain Python script)
failed on tooling alone even when the code was correct — the Planner now
infers a language-appropriate test command instead. `skill_gap_scanner`'s
knowledge-gap-triggered research path hasn't been observed on a live nightly
run yet (next natural run is its 3am schedule).
