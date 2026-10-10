# Growth engine

Implements Phases 6-9 of `docs/unified-architecture-gap-analysis.md`'s canonical roadmap: a unified Growth lifecycle (Observations → Opportunities → Proposals → Experiments → Evaluations → Consolidation), Skills v2's relevance-filtered skill loading, a named Context Builder, and the autonomous background loop that ties them together - turning Amy's existing signal-capture mechanisms (`behaviorFeedback`, `knowledgeGapTopic`, safety-net failures, tool failures, judge-derived review scores) into evidence-based self-improvement, instead of each one acting independently.

Lives inside `agent-service` rather than as its own microservice - the roadmap is explicit that this should "move the lifecycle into agent-service and the current architecture," not resurrect the n8n implementation it's based on. It does get its own Postgres database (`growth`), same one-database-per-concern convention as `memory`/`events`/`research`/`skills`.

## Prior art this builds on

Commit `96a56acd` (branch `origin/worktree-self-improvement-cycle`, Sep 2026) built a full Reviewer/Proposer self-improvement pipeline - a decomposed-rubric LLM judge, multi-cause attribution, and golden-transcript regression checks before any persona edit - but was never merged, because it was wired entirely into the n8n `Chat` workflow, which `agent-service` has since replaced as the live request path. See `docs/unified-architecture-gap-analysis.md` §4 for the full writeup.

The schema and rubric design were validated there; only the implementation was stale. This project ports the schema and the golden-transcript seed data (`postgres/init/27-seed-golden-transcripts.sql`), not the n8n workflows.

**§9's archival step, resolved:** the original roadmap said to archive `sijudgesub0001x.json`/`siproposer0001x.json`/`sireviewer0001x.json` once Phase 6 was implemented and verified. Checked directly: none of those three files exist anywhere in the current working tree, on any branch reachable from `main` - they only ever existed inside the single commit `96a56acd` on the orphaned `origin/worktree-self-improvement-cycle` branch, which was never merged. There's nothing to delete or move; the "archival" is simply this note. The branch itself is left alone as historical reference, per the roadmap's own instruction, and was never operational in the first place (its commit message: "Ships inactive; needs a manually-created Postgres credential before activating").

One real surprise found while building Phase 6.5: the gap-analysis doc's claim that `personas.proposed_system_prompt`/`proposed_reason` were "already dormant" turned out to be only half right. A direct check of the live `n8n` database found the columns genuinely didn't exist on `public.personas` *the view* - but the underlying Data Table already had them, populated since 2026-08-21 with a real, still-unreviewed proposal (about adding software-development/GitHub capabilities to Amy's persona), evidently written by `skill_gap_scanner`'s persona-change branch. `postgres/init/25-add-persona-proposal-columns.sql`'s `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` correctly no-op'd against the real table and the `CREATE OR REPLACE VIEW` surfaced that pre-existing data through `public.personas` for the first time. That August proposal is still sitting there, unreviewed - worth a human actually looking at it directly, since `growth_review` only surfaces `growth_proposals`, not raw `personas.proposed_*` rows that predate the Growth engine.

## Phase 6.1 - Unified Growth data model

`postgres/init/24-create-growth-db.sql` creates the `growth` database with two table groups:

**Ported from `96a56acd`**: `persona_snapshots`, `review_turns`, `review_cursor`, `review_scores`, `review_attributions`, `golden_transcripts`, `golden_regression_runs`, `review_runs`. Hashing moved from SQL's `md5()` to Python (no Code-node-sandbox equivalent risk in this architecture).

**New** (the general lifecycle `96a56acd` never had, since it only ever reviewed persona behavior): `growth_opportunities`, `growth_observations`, `growth_proposals`, `learning_plans`, `experiments`, `evaluations`, `growth_history`.

`agent-service/src/growth_db.py` is the data-access module. Turn-logging (`log_review_turn`) is wired into `main.py`'s post-turn persistence `asyncio.gather`, capturing the persona hash, message, reply, tool calls, and both Honcho peer-card snapshots on every turn.

## Phase 6.2/6.3 - Opportunity scoring + classification

`growth_db.record_observation(config, source, summary, evidence, session_id, category)` is the single entry point every signal now goes through:

```
signal -> observation -> accumulate (dedup by normalized title) -> score -> propose only when worthwhile
```

Score = `frequency + usefulness + confidence + reuse_potential + improvement_value - effort - interruption_cost`, per the roadmap's model. Each dimension (besides frequency, which accumulates) gets a deterministic default from `_SOURCE_DEFAULTS`, keyed by source (`tool_failure`, `safety_net_failure`, `user_correction`, `behavior_feedback`, `knowledge_gap`, `idle_reflection`, `skill_gap_scan`, `review_score`) - same rule-based-over-LLM-call preference as the rest of this project's routing logic, not a claim of precision. `classify_category` maps a source (and, for `behavior_feedback`, its own sub-category) to a Growth category (`knowledge`/`skill`/`behavior`/`tool`).

An opportunity is promoted to a `growth_proposals` row once it clears `PROPOSAL_SCORE_THRESHOLD` (8.0) at `PROPOSAL_MIN_FREQUENCY` (2), or hits a high-confidence shortcut - generalizing `96a56acd`'s own evidence threshold ("≥2 qualifying attributions in 14 days, or one at confidence ≥0.9") past persona review to every category.

**Wired signal sources** (`main.py`): `knowledgeGapTopic` and `behaviorFeedback` (additive to their existing destinations - the research queue and event-bus respectively, unchanged), plus six safety-net failure checks (`has_unfulfilled_search_intent`, `is_confabulated_action`, `has_fabricated_id_reference`, `has_status_narration_mismatch`, `has_unsatisfied_required_tool`, `has_trailing_confirmation_question`) that previously only triggered a retry and now also record a `safety_net_failure` observation.

**`user_correction` (follow-up fix):** `classify.py`'s own design deliberately excludes single-turn corrections from `behaviorFeedback` ("those are ordinary corrections, not behavior feedback; use null for them") - which meant the roadmap's own named "user corrections" signal was never actually captured anywhere. Fixed with a new, independent `isCorrection` boolean field (not reusing or loosening `behaviorFeedback`'s definition) plus a deterministic guard in `classify_relevant_tools`: it's only ever true when a prior exchange was actually provided to the classifier (a correction is inherently about the immediately preceding turn - the model's own output is distrusted here the same way `calculate`/`safety_net.py` distrust it elsewhere). Live-verified with a real two-turn exchange ("what's 5+5" -> "5"; "no, I asked for 5+6" -> correctly detected, scored, and correctly held at `status='scored'` rather than promoted, since one observation doesn't clear `PROPOSAL_MIN_FREQUENCY`).

Verified live: two identical `tool_failure` observations accumulate into one opportunity (frequency=2, score=11.0 ≥ threshold) and correctly auto-promote to a `growth_proposals` row.

## Phase 6.4 - The shared judge, experiments, evaluation

`agent-service/src/growth_judge.py`: one PydanticAI `Agent` (`NativeOutput(JudgeOutput)`, same structured-output pattern `classify.py` already proved reliable against this stack's Ollama), scoring five rubric dimensions (`task_success`, `relevance`, `persona_alignment`, `user_sentiment`, `followup_coherence`, each 1-5) plus a list of multi-cause attributions (`persona_text`/`honcho_peer_card`/`model_capability_limitation`/`tool_failure`/`ambiguous_user_request`/`none`, each with confidence and quoted evidence). Runs on `config.growth_judge_model` (`qwen3:14b` by default, not the 8b model live chat/classification use - an 8b judge is a documented reliability risk for reflective-reasoning tasks in this project).

`check_golden_regression(config, current_persona, candidate_persona)`: replays every `golden_transcripts` row's user turns as a plain, non-tool chat completion (golden transcripts are ordinary conversation, no tool calls expected) against both personas, judges each regenerated exchange, and flags a regression if the candidate scores worse than either the transcript's `expected_min_scores` bar or the current persona's own baseline on that transcript. Writes to `golden_regression_runs`.

Generic `create_experiment`/`record_evaluation` give any future baseline-vs-candidate comparison (not just persona edits) a place to live - used today specifically by the golden-regression check inside consolidation (below), as a real, populated example rather than schema sitting empty.

## Phase 6.5 - Consolidation + the growth_review approval tool

`agent-service/src/growth_consolidate.py::consolidate_proposal` dispatches an **already-approved** proposal (`growth_proposals.status = 'approved'`) by category:

| Category | Destination |
|---|---|
| `knowledge` | `entities` (research DB, `type='learning'`) via the existing `knowledge_client.create_entity_from_chat` |
| `skill` | A new active instruction skill, written directly into n8n's Data-Table-backed `skills` table (`growth_db.consolidate_skill`) |
| `tool` | `skill_proposals` (`kind='tool_idea'`) - reuses the existing human-review queue instead of inventing a parallel one |
| `behavior` | A candidate persona edit into `personas.proposed_system_prompt`/`proposed_reason` (`growth_db.propose_persona_edit`), **after** a golden-transcript regression check, and still requiring separate manual promotion into the live `system_prompt` - never auto-applied, same guarantee as every other self-authoring mechanism in this project |

`agent-service/src/growth_routes.py` mounts `GET /growth/opportunities`, `GET /growth/proposals`, `GET /growth/proposals/{id}`, `POST /growth/proposals/{id}/approve`, `POST /growth/proposals/{id}/reject` into the existing FastAPI app. Approving immediately triggers consolidation.

`skills-mcp/src/tools/growth-review.ts` (`growth_review` MCP tool, exposed under the `self-growth` classifier group) is the human-approval surface - same conversational-approval idiom as `skill_propose`/`task_context_manage`/`goal_manage`, not a new chat-ui page. A user can say "what has Amy noticed about herself lately" or "show me pending growth proposals" and get a real answer; approving or rejecting happens the same way.

Verified live end-to-end: a `tool`-category test proposal, approved via the HTTP route, correctly landed a real row in `skill_proposals` and a complete `growth_history` audit trail (`observed → observed → proposed → approved → consolidated`). A `behavior`-category test proposal correctly ran the golden-transcript regression check against both seeded transcripts and wrote `personas.proposed_system_prompt` (test data was reverted afterward - see the real August proposal note above, which this test had to work around carefully).

### Follow-up gap fixes

Re-reading the roadmap's own diagrams against the shipped code surfaced five real gaps, not just cosmetic ones - fixed here:

1. **Learning Plans were never created.** The roadmap's diagram is `Proposal → Learning Plan → Experiment → Evaluation → Consolidation`; the first build went straight `Proposal → Consolidation`. `growth_db.create_learning_plan` now creates a plan from a fixed per-category step template (`LEARNING_PLAN_TEMPLATES`) the moment a proposal is approved, and `growth_consolidate.py` advances each step as it actually happens.
2. **`skill`-category proposals skipped evaluation entirely.** Phase 6.4's own example ("create Job Evaluation v1, run it against 10 historical examples, compare") only ever got wired for the `behavior` path (golden-transcript regression). `growth_judge.evaluate_skill_plausibility` is the fix: a judge-based plausibility check against the opportunity's own linked `growth_observations` (not a full behavioral simulation - there's no lightweight way to re-run a real agent turn with a hypothetical new skill without reimplementing the whole chat flow). Recorded as a real `experiments`/`evaluations` row. Below `SKILL_EFFECTIVENESS_PASS_THRESHOLD` (4/5), the skill still gets written - the human already approved it via `growth_review` - but its `reason` gets a loud `⚠️ LOW-CONFIDENCE` prefix instead of silently looking as sound as a high-scoring one, same informational-not-blocking pattern the golden-regression check already used for `behavior`.
3. **The autonomy model wasn't actually differentiated.** §8 defines three real tiers; every proposal was hardcoded to `'tier2'` regardless of category. `growth_db.APPROVAL_TIER_BY_CATEGORY` now maps `knowledge → tier1` (§8 explicitly lists "learn factual knowledge" as autonomous) and `skill`/`tool`/`behavior → tier2` (§8's own "activating a new skill"/"changing persona behavior"/"installing capabilities" language). A Tier 1 proposal is created already `approved` and immediately consolidated in the same call - no human ever sees it in the default `growth_review` queue, by design. Tier 3 has no code path at all: nothing in the Growth engine touches identity/safety/permissions tables, so there's nothing to gate.
4. **Graphiti wasn't wired into Growth at all**, despite §10's target architecture explicitly putting Growth's "development history" under it. `agent-service/src/growth_graphiti.py` is a thin fire-and-forget client (same request shape and "only at a meaningful moment" convention event-bus/knowledge-engine already use for their own episodes) - fires at `proposed` and `consolidated`, not every raw observation. `agent-service` didn't even have `GRAPHITI_SERVICE_URL` wired before this (only `coding-orchestrator` did).
5. **§9's archival step** - see the note under "Prior art" above; there was nothing to actually archive.

### Smaller follow-up gaps

- **Skill L3/L4 surfacing.** `skills_discovery.py`'s `render_skills_catalog_text` now includes `level3_procedure` for skills that were a *direct* trigger match (not a dependency-only pull) - a dependency stays at L2 to avoid stacking detail onto something that's only supporting context. L4 (`level4_examples`) is still never injected unconditionally (typically long, no multi-turn drill-in mechanism); instead it's retrievable on demand via the new `skill_examples` MCP tool (`skills-mcp`), the natural agentic equivalent of actually asking for more detail. Always bound regardless of classification, same tier as `calculate`/`task_context_manage`.
- **The `user_correction` signal.** `classify.py` deliberately excludes single-turn corrections from `behaviorFeedback` ("ordinary corrections, not behavior feedback") - which meant the roadmap's own named "user corrections" signal was never actually captured by anything. Fixed with an independent `isCorrection` boolean, gated by a deterministic check (`is_correction = bool(parsed.is_correction and recent_context)`) since a correction is inherently about the immediately preceding turn - the model's own output is distrusted here the same way `calculate`/`safety_net.py` distrust it elsewhere. Live-verified with a real two-turn exchange.
- **Persona proposals were only reachable via raw SQL.** `growth_db.get_persona_proposal`/`promote_persona_proposal` + two new `/growth/persona-proposal*` routes + two new `growth_review` actions (`persona_proposal`, `promote_persona`) make the real, still-pending 2026-08-21 proposal (see "Prior art" above) actually visible and actionable conversationally for the first time, without changing the guarantee that promotion is never automatic.

  **Real safety issue found and fixed while building this:** that August proposal turned out to be a ~666-character reasoning paragraph ("Amy's current persona instructions already emphasize...") written by `skill_gap_scanner`'s old reflection process, NOT a full replacement persona text - unlike Growth's own `propose_persona_edit`, which always writes current-persona-plus-addition (so it's always a safe full replacement). Promoting the August proposal as originally implemented would have silently overwritten the real 8300-character persona with that short paragraph, destroying it. `growth_db.promote_persona_proposal` now refuses when the proposed text is under `PERSONA_PROMOTE_MIN_LENGTH_RATIO` (0.5) of the current persona's length, returning a clear reason instead of a silent no-op. Live-verified both ways: refused correctly against the real August proposal (666 vs. 8300 chars); succeeded correctly against an isolated test row with a long-enough proposed text (the real `Amy` row was never touched by either test).

## Phase 7 - Skills v2 runtime

`postgres/init/26-create-skill-metadata-table.sql` adds `skill_metadata` to the existing `skills` database - additive, keyed by skill name (a value match against the live `skills` table, not a real FK, since the two tables live in different Postgres databases). A skill with no metadata row behaves exactly as it did before this phase: always injected, full instructions.

`agent-service/src/skills_discovery.py`: `discover_relevant_skills` is a deterministic keyword-trigger filter (same rule-based-over-LLM-call preference as the rest of the routing logic in this project) - a skill matches if its `triggers` appear in the message text or its name matches a classified group, and pulls in one level of declared `dependencies` even if they didn't match themselves (Phase 7.2 composition). `render_skills_catalog_text` renders L1 (name/description) + L2 (`level2_summary`, falling back to the full instructions when unset) for every selected skill.

**Known gap, not silent**: L3 (`level3_procedure`)/L4 (`level4_examples`) are stored in the schema but never surfaced - there's no "drill into this skill" mechanism in a single-pass prompt assembly to make use of them yet. Follow-up work, not a bug.

## Phase 8 - Context Builder extraction

`agent-service/src/context_builder.py::build_context` - a pure relocation (same calls, same order, same log lines) of the parallel gather + Honcho card fetch + skill discovery + system-prompt assembly that used to be inlined in `main.py`. Per the roadmap: "do not rewrite working context assembly just because the architecture diagram calls it Context Builder - you already have it." Deliberately one module, not a `context/` subpackage - there wasn't enough distinct logic to justify splitting further.

Side effects that happen to be decided alongside classification (`knowledgeGapTopic` enqueue, `behaviorFeedback` publish, Growth observations, memorable-item promotion) stay in `main.py` - they're consequences of classification, not context the prompt itself needs.

Verified: a real chat turn through the rebuilt `agent-service` produced an identical response shape (classify trace → tool call → reply) after this extraction, and `python -m pyflakes` found zero undefined names or unused imports across every touched file.

## Phase 9 - The autonomous Growth loop

`agent-service/src/growth_background.py::start_background_loop`, started from a FastAPI startup hook in `main.py`. Every 30 minutes (matching `idle_reflection`'s existing cadence): pulls not-yet-reviewed `review_turns` past `review_cursor.last_reviewed_at`, groups by session, runs the shared judge on each session's transcript, persists `review_scores`/`review_attributions`, and feeds any actionable attribution (`tool_failure`, `persona_text`, `honcho_peer_card`, `ambiguous_user_request` - `model_capability_limitation` and `none` aren't addressable by a Growth action, so they're skipped) into `record_observation`, which handles its own scoring/promotion.

This is what makes `review_scores`/`review_attributions` real rather than permanently empty, and closes the loop: **Amy interacts → experiences → observations → Growth evaluates → should I improve? → (only on approval) → consolidate → better Amy.**

Tier 1 only (autonomy model, `docs/unified-architecture-gap-analysis.md` §8): the loop judges, observes, scores, and proposes entirely on its own. It never approves or consolidates anything - that's still `growth_review`'s job, always a human decision.

## Operational notes

Applying migrations (none run automatically - the `postgres-data` volume already exists):
```
docker compose exec -i postgres psql -U assistant -d postgres < postgres/init/24-create-growth-db.sql
docker compose exec -i postgres psql -U assistant -d n8n < postgres/init/25-add-persona-proposal-columns.sql
docker compose exec -i postgres psql -U assistant -d skills < postgres/init/26-create-skill-metadata-table.sql
docker compose exec -i postgres psql -U assistant -d growth < postgres/init/27-seed-golden-transcripts.sql
```

Rebuilding (both are built from a Dockerfile, not a bind mount):
```
docker compose build agent-service skills-mcp
docker compose up -d agent-service skills-mcp
```

New env vars, all optional with working defaults: `GROWTH_DB_NAME` (growth), `SKILLS_DB_NAME` (skills, agent-service side), `GROWTH_JUDGE_MODEL` (qwen3:14b), `AGENT_SERVICE_URL` (skills-mcp side and chat-ui side, both default `http://agent-service:3010`).

## The Growth dashboard (Amy Lab)

Conversational review via `growth_review` doesn't scale to overseeing a system that continuously proposes improvements - a dedicated "Growth" category was added to Amy Lab (`chat-ui/src/components/amy-lab/growth/`), five sub-tabs: **Overview** (pending approvals, active learning plans, recent evaluations, failed experiments, recently consolidated - explicitly framed around "fewer repeated mistakes, not more activity," not a raw count dashboard), **Opportunities** (filter/sort, score breakdown, dismiss/defer/promote), **Review Queue** (proposals plus the legacy persona proposal, evidence, "what happens on approval" per category, approve/reject), **Learning Plans** (plans + experiments/evaluations), **History** (the full append-only log).

Backend additions this required, since `growth_db.py` previously had no read path for several tables and no human-override for an opportunity below the auto-promotion threshold: `list_learning_plans`, `list_experiments` (joined with its evaluation), `list_growth_history`, `set_opportunity_status` (dismiss/defer), and `promote_opportunity_to_proposal` (manual override - reuses the exact same proposal-creation path as automatic promotion, including Tier 1 auto-consolidation, via a `_create_proposal_from_opportunity` helper extracted from `_maybe_promote`).

`chat-ui/src/lib/growth-client.ts` calls `agent-service`'s `/growth/*` routes directly (same pattern `skills-registry-client.ts` already uses for skills-mcp) via a new `AGENT_SERVICE_URL` env var on the `chat-ui` container - chat-ui had no direct line to agent-service before this beyond the chat webhook itself.

**Known gap in the Review Queue, not silent**: a proposal only stores `proposed_action`/`rationale` (a description), not the actual generated candidate text - the real persona-edit text or skill instructions are only generated at consolidation time, inside `growth_consolidate.py`, not stored ahead of approval. So the Review Queue shows evidence and a deterministic "what happens on approval" explanation per category, not a true before/after diff preview. The one exception is the legacy persona proposal, which already has its full candidate text available (it predates this distinction) and is shown in full with a current-vs-proposed length comparison.

Verified live with a real headless-browser pass (Playwright) against the actual running stack: all five tabs render correctly against real accumulated data (10 real opportunities from actual usage, the real persona-dismissal history entry), zero console/page errors, and the opportunity-row expand interaction correctly surfaces the score breakdown and action buttons.
