# Growth engine

Implements Phase 6 of `docs/unified-architecture-gap-analysis.md`'s canonical roadmap: a unified Growth lifecycle (Observations → Opportunities → Proposals → Learning Plans → Experiments → Evaluations → Consolidation) that turns Amy's existing signal-capture mechanisms (`behaviorFeedback`, `knowledgeGapTopic`, `idle_reflection`, `skill_gap_scanner`, tool failures, safety-net failures, user corrections) into evidence-based self-improvement, instead of each one acting independently.

Lives inside `agent-service` rather than as its own microservice — the roadmap is explicit that this should "move the lifecycle into agent-service and the current architecture," not resurrect the n8n implementation it's based on. It does get its own Postgres database (`growth`), same one-database-per-concern convention as `memory`/`events`/`research`/`skills`.

## Prior art this builds on

Commit `96a56acd` (branch `origin/worktree-self-improvement-cycle`, Sep 2026) built a full Reviewer/Proposer self-improvement pipeline — a decomposed-rubric LLM judge, multi-cause attribution, and golden-transcript regression checks before any persona edit — but was never merged, because it was wired entirely into the n8n `Chat` workflow, which `agent-service` has since replaced as the live request path. See `docs/unified-architecture-gap-analysis.md` §4 for the full writeup.

The schema and rubric design were validated there; only the implementation was stale. This phase ports the schema, not the n8n workflows.

## Phase 6.1 — Unified Growth data model (done)

`postgres/init/24-create-growth-db.sql` creates the `growth` database with two table groups:

**Ported from `96a56acd`** (persona/conversation review machinery): `persona_snapshots`, `review_turns`, `review_cursor`, `review_scores`, `review_attributions`, `golden_transcripts`, `golden_regression_runs`, `review_runs`. Unchanged from the original design except: hashing moved from SQL's `md5()` to Python (no Code-node-sandbox equivalent risk in this architecture), and the `proposal_generated_at` cursor on `review_scores` now conceptually points at a `growth_proposal`/`growth_opportunity` rather than only a persona edit.

**New** (the general lifecycle `96a56acd` never had, since it only ever reviewed persona behavior): `growth_opportunities`, `growth_observations`, `growth_proposals`, `learning_plans`, `experiments`, `evaluations`, `growth_history`. See the SQL file's own comments for the rationale behind each column.

`agent-service/src/growth_db.py` is the data-access module: a dedicated `asyncpg` pool against the `growth` database (`config.postgres.growth_database`, env `GROWTH_DB_NAME`, defaults to `growth`), parallel to how `db.py` already connects to the `n8n` database for personas/skills.

**Turn-logging is wired and live**: `agent-service/src/main.py`'s existing post-turn persistence `asyncio.gather` (next to the Honcho/memory-engine writes) now also calls `growth_db.log_review_turn(...)`, capturing the persona text's hash (deduped via `persona_snapshots`), the user message, the agent's reply, the tool calls made, and a point-in-time snapshot of both Honcho peer cards. This is pure capture — no scoring, classification, or autonomous action — so it needs no approval-tier gating (it's the Tier 1 "create internal observations" case from the autonomy model, §8 of the gap-analysis doc). Verified live: a real turn through the running `agent-service` produced a correct `review_turns` row referencing a real `persona_snapshots` hash, with no added failure modes and negligible latency (~sub-second, alongside the other three post-turn writes already happening there).

`growth_opportunities` onward are schema-only for now — nothing writes to them yet.

## What's next (not yet built)

- **Phase 6.2 — Opportunity scoring.** Accumulate `growth_observations` (from the existing signal sources, plus new ones: tool failures, safety-net failures, user corrections, `review_scores`) against a `growth_opportunities` row, and compute `score` from the roadmap's weighted model (`frequency + usefulness + confidence + reuse_potential + improvement_value - effort - interruption_cost`) so a proposal only gets generated when it clears a threshold.
- **Phase 6.3 — Classification.** Route each scored opportunity into `knowledge` / `skill` / `behavior` / `tool`.
- **Phase 6.4 — Experiments + Evaluation.** Wire the shared-judge pattern (one prompt reused by live review and golden-transcript regression, so wording can't diverge) as a Python function, generalized beyond persona review to any baseline-vs-candidate comparison.
- **Phase 6.5 — Consolidation.** Decide where a passed evaluation lands — `entities` (research DB, using its reserved `learning`/`decision`/`preference` types), the skills catalog, or a persona edit via the already-dormant `personas.proposed_system_prompt` column (Tier 2, always human-approved).

## Operational notes

- Applying the migration against the existing `postgres-data` volume (it won't run automatically — same caveat as every other file in `postgres/init/`):
  ```
  docker compose exec -i postgres psql -U assistant -d postgres < postgres/init/24-create-growth-db.sql
  ```
- `agent-service` needs a rebuild (`docker compose build agent-service && docker compose up -d agent-service`) to pick up `growth_db.py`/`main.py`/`config.py` changes — it's built from a Dockerfile, not a bind mount.
