# Unified Amy architecture: gap analysis & roadmap

A vision document proposed a unified cognitive architecture for Amy: a Context Builder that assembles only what's needed per turn, explicit memory layers (identity / user / episodic / semantic / procedural / project / growth), first-class dynamically-loaded skills, and a Growth engine that turns observations into opportunities → proposals → experiments → evaluations → consolidated improvements.

This doc maps that vision onto what's actually built today, so the next build phase starts from "what's the real gap" instead of "what should exist in theory." Short version: **most of the vision already exists, under different names, at different maturity levels.** The real gaps are (1) no unified Growth lifecycle — several independent signal-capture mechanisms exist but nothing scores/proposes/experiments/evaluates the way the vision describes, (2) skills are flat and always-on rather than first-class objects with dynamic, leveled loading, and (3) the context-assembly logic that already exists isn't named or extracted as its own module. There's also real prior art for the Growth engine specifically — a full Reviewer/Proposer pipeline built in September 2026, never merged, stale now because it was wired into an n8n workflow that's since been replaced — whose *schema and rubric design* is still worth reusing even though its implementation isn't.

> **Implementation status:** Phases 6–9 of the roadmap below (§7) are built and live-verified on branch `amy-phase6-growth-engine`. Full build details, what was ported vs. new, and what's still a known gap live in `docs/growth-engine.md` — this doc stays as the conceptual design reference.
>
> **2026-10 update:** a separately-drafted "unified Memory, Skills, Teaching & Growth" proposal was reconciled against the live Phases 6–9 build. Verdict and a new Phase 10 (Teaching — the one genuinely missing layer) are in §11.

## 1. Current architecture snapshot

Amy is built as a set of small, single-purpose services, each with its own Postgres database, wired together via `docker-compose.yml`. The system is mid-way through a deliberate "5-pillar rebuild" (current branch: `amy-phase5-dspy-classifier-optimizer`) replacing hand-rolled pieces with established frameworks one pillar at a time: **PydanticAI → OpenHands → Graphiti → Scrapling → DSPy**. That ordering is documented in `docs/dspy-optimizer.md` and corresponds to pillars 1–5 below.

| Service | Role | Rebuild pillar | Status |
|---|---|---|---|
| `chat-orchestrator/` | Original Node/TS turn orchestrator (the "Coordinator") | — (pre-rebuild) | Still deployed, kept only as instant rollback. No longer the live path for `chat-ui`/`discord-bot`. |
| `agent-service/` | Python/PydanticAI port of the Coordinator | 1 | **Live** — `chat-ui` and `discord-bot` point here (`docker-compose.yml`, `N8N_WEBHOOK_URL`/`N8N_CHAT_WEBHOOK_URL` → `agent-service:3010/webhook`). |
| `skills-mcp/` | MCP server hosting all agent-callable tools | — | Live, consumed by n8n, chat-orchestrator/agent-service, coding-orchestrator. |
| `memory-engine/` | Self-hosted deterministic cross-conversation recall | — | Live, mature. Replaced Honcho's hosted dialectic API for this purpose. |
| `knowledge-engine/` | Document/world-knowledge store + web research + router | — | Live, most mature subsystem in the repo. |
| `graphiti-service/` | Decision/project/growth ledger graph (FalkorDB + Ollama) | 3 | Live but narrow — only goal-creation and entity-creation events produce episodes so far. |
| `openhands-runner/` | Wraps OpenHands SDK as coding-orchestrator's execution engine | 2 | Live. |
| `scrapling-service/` | Real page fetching/extraction for research | 4 | Live, backs knowledge-engine's web research. |
| `dspy-optimizer/` | Offline few-shot optimizer for the classifier prompt | 5 | Manual, offline-only tool, not a runtime dependency. Current branch is post-merge polish on this pillar. |
| `coding-orchestrator/` | Planner → Coder → Tester → Reviewer state machine | — | Live. |
| `event-bus/` | Event ingestion, goal tracking, task-context steps | — | Live. |

Two separate phase-numbering systems coexist in the docs/commit history and are easy to conflate:
- **The 5-pillar rebuild** (above) — what the current branch name refers to.
- **The Coordinator's own internal build history**, documented in `docs/chat-orchestrator.md` as phases 0–8 (eval harness → classifier schema → tool-policy enforcement → memory-policy gating → task/goal context injection → post-tool verification → streaming narration → ...). Phases 7 ("deterministic-only memory confidence/supersession") and 8 ("sub-workflow decomposition") are explicitly tabled, not started.

### Today's per-turn request flow

Traced in `agent-service/src/main.py` (`POST /webhook`):

1. Pull recent session history for anaphora resolution.
2. `asyncio.gather` of 7 things in parallel: classify (`classify.py`), persona system prompt, active instruction skills, memory search, matching task contexts, matching goals, open projects.
3. Fire-and-forget side effects from the classifier's output: enqueue research for a detected knowledge gap, publish+persist behavior feedback, persist "memorable items" as entities.
4. Filter memory results by relevance; lazily fetch Honcho peer cards if needed.
5. `build_system_prompt` (`agent-service/src/system_prompt.py`) assembles persona + date/time + user card(s) + skills catalog + relevant memories + open tasks/goals/projects + planning/acknowledgment nudges.
6. Decide whether to stream a deterministic "ack" phrase, then run the PydanticAI agent turn with tools scoped to exactly what the classifier marked relevant.
7. A deterministic safety net (`agent-service/src/safety_net.py`) runs retry/verification passes (empty reply, unfulfilled search intent, confabulated action, fabricated ID, status-narration mismatch, missing required tool call, stock trailing question).
8. Persist the turn to Honcho/memory-engine.

This is already, functionally, a Context Builder — it just isn't named or extracted as one (see §6).

## 2. Component-by-component mapping

| Vision concept | Current implementation | Gap |
|---|---|---|
| **Context Builder** | `agent-service/src/main.py`'s parallel gather + `system_prompt.py`'s `build_system_prompt` | Purely organizational — exists, isn't named/extracted. See §6. |
| **Identity / persona** | `personas.system_prompt` (Postgres, DB-driven), read via `get_persona_system_prompt()` | None functionally; editing today is manual SQL (see `docs/persona-system.md`). |
| **User model** | Honcho hosted "peer cards": the user's own card (durable facts) + the user's directional card *for* Amy (behavioral instructions), injected into the system prompt every turn | No unified `user/` library or Postgres-backed preference table — the user model lives entirely in an external hosted service. |
| **Episodic memory** | `memory-engine/` — deterministic hybrid (vector + keyword + recency) search over every stored turn, no LLM in the hot path | Mature; closest 1:1 match to the vision. |
| **Semantic / world knowledge** | `knowledge-engine/` — ingestion (text/URL/PDF), hybrid retrieval with citations, deterministic knowledge-vs-web router, multi-step research agent | Mature; closest 1:1 match to the vision. |
| **Growth / decision ledger** | `graphiti-service/` — FalkorDB-backed graph, episodes written at meaningful moments (goal created, entity created) | Narrow: only two event types produce episodes today, vs. the vision's full "Problem → Learning Plan → Skill → Experiment → Evaluation" graph. |
| **Skills** | Postgres `skills` table (`kind`: `instruction`/`tool_idea`), always-injected as a flat markdown catalog; human-approved via `skill_propose` (`skills-mcp/src/tools/skill-propose.ts`); proactively scanned daily by `skill_gap_scanner` (n8n) | No dynamic discovery/selection, no levels (metadata → core → procedure → examples), no first-class triggers/inputs/outputs/eval-criteria/versioning. See §5. |
| **Proposed-data staging** | Partial equivalents exist per-subsystem: `skill_proposals` table, `research_queue`, `entities.graphiti_id` backfill, dormant `personas.proposed_system_prompt`/`proposed_reason` columns | No single universal staging mechanism — each subsystem invented its own. Not necessarily a problem (see §7), but worth naming explicitly if a Growth engine needs one shared pattern. |
| **Growth engine (opportunities → experiments → evaluation)** | Signal capture exists and runs (`behaviorFeedback` → entities, `idle_reflection`, `skill_gap_scanner`); nothing above that scores opportunities, runs experiments, or evaluates before/after | **The biggest real gap.** Full deep-dive in §4 — including real prior art that was built and abandoned. |
| **Approval tiers (auto / user-approval / always-approval)** | De facto exists per-mechanism (skill proposals and idle-reflection messages are always human-gated) but not as one explicit, named three-tier policy | Mostly organizational; see §7's open decision. |

## 3. Entities table — the seed of a unified user/growth model

`postgres/init/23-create-entities-table.sql` is worth calling out on its own: its `type` column already reserves values for `user_fact`, `preference`, `learning`, `decision`, and `document` — i.e., the schema already anticipates something close to the vision's unified memory-layer taxonomy — but per the schema's own comment, only `'project'` is actually populated today; the rest are "reserved for later phases." This table, plus its optional `graphiti_id` link to a Graphiti episode, is the most natural foundation to build the Growth engine's opportunity/proposal records on top of, rather than inventing a new table from scratch.

## 4. Deep dive: Growth engine

### What already runs today
- `behaviorFeedback` (classifier side-channel) → published to event-bus, promoted into a durable `entities` row, visible in Amy Lab's Growth tab (`chat-ui/src/components/amy-lab/EntitiesView.tsx`).
- `knowledgeGapTopic` (classifier side-channel) → enqueued into knowledge-engine's self-learning `research_queue` (`knowledge-engine/src/engine/research-queue.ts`).
- `idle_reflection` — a 30-minute autonomous n8n check (`n8n/workflows/idlereflection0001.json`) that can propose a skill or, cooldown-gated, message the user.
- `skill_gap_scanner` — a daily n8n workflow (`n8n/workflows/skillgapscan001x.json`) that reflects across capabilities/personality/knowledge via Honcho's dialectic endpoint and writes new `skills` rows, plus a dormant persona-change branch.

None of these do rubric scoring, multi-cause attribution, before/after experiments, or a scored backlog of opportunities — they're closer to the vision's "observation → proposal" edge than the full lifecycle.

### What was already built and abandoned
Branch `origin/worktree-self-improvement-cycle` (one commit, `96a56acd`, Sep 3 2026) built almost exactly the vision's Growth-engine design, then was never merged — main moved on into the 5-pillar rebuild instead, and the branch sat for over a month before being superseded by architecture changes that make its implementation stale. It is **not dead because the idea was wrong; it's stale because it was wired into infrastructure (the n8n `Chat` workflow) that no longer exists in the live path.**

What it built, concretely (`self_improvement` Postgres DB):

- **`persona_snapshots`** — persona text deduped by `md5(system_prompt)`, so every scored turn can reference exactly which persona version was live, by hash, without duplicating the full prompt per row.
- **`review_turns`** — per-turn capture of user message, agent reply, full tool-call trace, *and a point-in-time snapshot of both Honcho peer cards* — something no other system here captures, since the live peer-card endpoints only ever show the current card, not what it said historically.
- **`review_scores`** — one row per (session, chunk), five independent 1–5 rubric dimensions: `task_success`, `relevance`, `persona_alignment`, `user_sentiment`, `followup_coherence`. Deliberately decomposed rather than one holistic score, because decomposed criteria correlate better with human judgment.
- **`review_attributions`** — **one-to-many** per score row, attribution types: `persona_text`, `honcho_peer_card`, `model_capability_limitation`, `tool_failure`, `ambiguous_user_request`, `none`, each with a confidence and quoted evidence. Explicitly one-to-many because a real incident (2026-07-28, a persona/peer-card tone drift) had two independent causes behind one symptom — a single-cause reviewer would have "fixed" one and left the other live.
- **`golden_transcripts` + `golden_regression_runs`** — a curated regression set (seeded with the 07-28 incident, plus a post-fix "good" transcript as a canary) that any candidate persona edit gets replayed against before being surfaced for approval, so a fix for one failure mode can't silently regress another.
- **`review_cursor`, `review_runs`** — incremental-scan watermark and audit trail.
- A **proposer** that only acted on a deterministic evidence threshold (≥2 qualifying attributions in 14 days, or one at confidence ≥0.9 with a low alignment score), edited only the specific persona section the evidence pointed at, ran the regression check, and wrote to the already-dormant `personas.proposed_system_prompt`/`proposed_reason` columns — never auto-applying, same human-approval gate as every other self-authoring mechanism in this project.

### Recommendation
Treat the *schema and rubric design* as validated prior art, not the n8n implementation. Re-home it onto `agent-service`:
- Turn-logging becomes a side-effect inside `agent-service/src/main.py`'s existing post-turn persistence step (next to the Honcho/memory-engine writes), not a bolt-on to a retired workflow.
- The "shared judge" concept (one prompt, reused by both live review and golden-transcript regression so wording can't diverge) ports directly as a Python function in `agent-service`.
- The scoring model from the vision (frequency / usefulness / confidence / effort / interruption-cost) is a good fit for deciding *which* accumulated `review_scores`/`review_attributions` evidence actually becomes a surfaced proposal — this is the piece `96a56acd` under-specified (its proposer used a single deterministic threshold, not a weighted score).
- The `entities` table's reserved `learning`/`decision` types (§3) are a natural home for consolidated Growth-engine outcomes, keeping one durable "Amy's world" registry instead of a second, parallel one.

## 5. Deep dive: Skills v2

Today: a flat Postgres `skills` table (`kind`: `instruction` or `tool_idea`), where every `active`/`instruction` row is unconditionally formatted into a markdown block and injected into *every* system prompt, regardless of relevance to the current turn (`get_active_instruction_skills()` in `agent-service/src/db.py`, formatted inline in `main.py` / via `chat-orchestrator/src/skills-catalog.ts`). New skills arrive through `skill_propose` (`skills-mcp/src/tools/skill-propose.ts`, model-invoked mid-conversation) or the daily `skill_gap_scanner` scan — both always human-reviewed before activation.

Gap vs. the vision: skills aren't first-class objects (no explicit triggers/inputs/outputs/procedure/eval-criteria/versioning/dependencies), and there's no dynamic, leveled loading (metadata → core instructions → detailed procedure → examples) — every active skill costs context on every turn whether or not it's relevant. This is additive work, not a replacement: the existing `skill_propose`/`skill_gap_scanner` human-approval pipeline stays as the authoring mechanism; what's missing is the *loading* side.

## 6. Deep dive: Context Builder formalization

Low urgency relative to §4/§5. The logic already exists and already works (the parallel gather + `build_system_prompt` in `agent-service/src/main.py` / `system_prompt.py`, mirrored in `chat-orchestrator/src/system-prompt.ts`). The gap is purely organizational: it isn't named as a "Context Builder" or extracted into its own module/service, which matters mainly if/when Skills v2 needs a clean integration point for relevance-based skill selection (a named Context Builder is a natural place to add "ask Skill Discovery what's relevant" as one more parallel-gather branch).

## 7. Canonical build roadmap

This supersedes §7/§8 of the original draft. The framing isn't "build the unified cognitive architecture" — most of it already exists. It's **unify Amy's existing cognitive systems through Growth, Skills v2, and Context Builder boundaries**, continuing the existing 5-pillar rebuild numbering as Phases 6–9, in priority order:

```
6. Growth Engine  →  7. Skills v2  →  8. Context Builder extraction  →  9. Autonomous Growth  →  10. Teaching layer  →  11. Proof of learning
```

That order gets the biggest capability jump first, while reusing the substantial work already done. None of the three foundational phases (6, 7, 8) strictly blocks another — #7 benefits from #8 being done first but doesn't require it — Phase 9 is the payoff that needs all three in place.

### Phase 6 — Growth Engine (highest priority)

Build on the abandoned `96a56acd` work rather than recreating it; move the lifecycle into `agent-service` and the current architecture instead of resurrecting the old n8n implementation.

```
Existing signals
    │
    ├── behaviorFeedback
    ├── knowledgeGapTopic
    ├── idle_reflection
    ├── skill_gap_scanner
    ├── tool failures
    ├── safety-net failures
    ├── user corrections
    └── review scores
             │
             ▼
     Growth Opportunity
             │
      ┌──────┴──────┐
      │             │
   score          classify
      │             │
      └──────┬──────┘
             ▼
       Growth Proposal
             │
             ▼
       Learning Plan
             │
             ▼
         Experiment
             │
             ▼
         Evaluation
             │
             ▼
     Approval / Decision
             │
             ▼
       Consolidation
             │
      ┌──────┼────────┐
      ▼      ▼        ▼
   Knowledge Skill  Behavior
```

**Reuse from `96a56acd`** (schema/rubric design, not the n8n implementation): `persona_snapshots`, `review_turns`, `review_scores`, `review_attributions`, `golden_transcripts`, `golden_regression_runs`, `review_cursor`, `review_runs`, the shared-judge pattern, the attribution model, the deterministic evidence threshold, and the regression-before-proposal behavior.

**Phase 6.1 — Unified Growth data model.** Before building autonomous behavior, establish the records:

```
Growth
├── Observations
├── Opportunities
├── Proposals
├── Learning Plans
├── Experiments
├── Evaluations
└── History
```

Operational state lives in Postgres. The existing `entities` table becomes the durable registry for *consolidated outcomes* — not a competing memory system — which is exactly what its reserved-but-unused types (`user_fact`, `preference`, `learning`, `decision`, `document`, alongside the already-used `project`) were anticipating (§3). The key distinction: **Growth records the development process; entities/knowledge/memory store the resulting durable knowledge.**

**Phase 6.2 — Growth Opportunity scoring.** The major missing intelligence. Instead of every signal immediately becoming a proposal (`signal → proposal`), accumulate evidence and score it first:

```
signal → observation → accumulate evidence → score opportunity → proposal only when worthwhile
```

```
Opportunity Score =
    frequency
  + usefulness
  + confidence
  + reuse potential
  + improvement value
  - effort
  - interruption cost
```

This is where Amy starts being selective rather than noisy — and it's the piece `96a56acd`'s single deterministic threshold under-specified.

**Phase 6.3 — Classify what Amy actually needs.** Every worthwhile opportunity gets classified before action is taken:

```
                  Growth Opportunity
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
   Knowledge            Skill             Behavior
       │                  │                  │
   Research/learn      Build/improve     Procedure change
```

A fourth branch — **Tool / Integration** — is worth reserving too. This classification step is what prevents every weakness from automatically becoming a new skill.

**Phase 6.4 — Experiments + Evaluation.** This is where the old Reviewer architecture is especially valuable, applied generally rather than only to persona edits:

```
Problem: Amy is inconsistent at job evaluation
        ↓
Baseline: 10 historical examples
        ↓
Create Job Evaluation v1
        ↓
Run same 10 examples
        ↓
Compare → Evaluation
        ↓
v1 succeeds / fails → v2 or abandon
```

Evidence-based self-improvement, not "I'm better now" — "the new procedure improved the evaluation score from X to Y across these test cases."

**Phase 6.5 — Consolidation.** Once an improvement passes evaluation, Growth decides where it belongs — the missing bridge between the various existing systems:

```
Learning
   ↓
┌──────────────┬──────────────┬──────────────┐
│              │              │              │
Knowledge      Skill        Preference     Decision
│              │              │              │
Knowledge      Skills/       User model     Graph/
Engine         Library                      entities
```

### Phase 7 — Skills v2

Upgrade the existing skills system rather than replacing it.

```
Current: skills → all active skills → every prompt

New:
User request → Skill Discovery → Candidate skills → Relevant skills → Load appropriate level
```

First-class skill object:

```
Skill
├── metadata
├── purpose
├── triggers
├── inputs
├── outputs
├── procedure
├── rules
├── tools
├── knowledge requirements
├── dependencies
├── failure handling
├── examples
├── evaluation criteria
└── versions
```

Loading levels — most turns should only need L1/L2, which directly addresses context-window and latency concerns:

```
L1  Metadata
        ↓
L2  Core instructions
        ↓
L3  Detailed procedure
        ↓
L4  Examples/reference material
```

**Phase 7.1 — Keep existing skill authoring.** Don't throw away `skill_propose`, `skill_gap_scanner`, human approval, or the existing Postgres skill records — those stay as the authoring side. Skills v2 only adds the missing runtime side:

```
Skill Registry
      │
      ├── discover
      ├── rank
      ├── load
      ├── compose
      └── version
```

This is a much smaller change than rebuilding skills entirely.

**Phase 7.2 — Skill composition.** Eventually a skill can declare dependencies (e.g. a "Job Evaluation" skill requiring `research`, `decision-analysis`, `resume-analysis`, `user-preference-retrieval`), and Skill Discovery resolves the dependency graph. This becomes especially powerful once Amy can create skills herself.

### Phase 8 — Context Builder extraction (intentionally low priority)

Do not rewrite working context assembly just because the architecture vision calls it "Context Builder" — it already exists and works (§6). Extract it into an explicit module boundary:

```
agent-service/
    context/
        builder.py
        retrieval.py
        skill_discovery.py
        assembly.py
```

`ContextBuilder.build(request)` becomes the one place responsible for assembling runtime context, internally parallelizing history/memory/user/tasks/goals/projects/knowledge/skills, then handing off `Context → Prompt → PydanticAI`. This gives Skills v2 a clean integration point without unnecessarily disturbing the existing runtime.

### Phase 9 — Amy's self-learning loop

Once Phases 6–8 exist, the original idea becomes a real loop:

```
                 ┌───────────────┐
                 │ Amy interacts │
                 └───────┬───────┘
                         ↓
                    Experiences
                         ↓
                     Observations
                         ↓
                 Growth evaluates
                         ↓
                "Should I improve?"
                         ↓
              ┌──────────┴──────────┐
              │                     │
             No                    Yes
              │                     │
           Monitor            Growth Proposal
                                    ↓
                              Learning Plan
                                    ↓
                                Experiment
                                    ↓
                                Evaluation
                                    ↓
                              ┌─────┴─────┐
                              │           │
                           Failed      Successful
                              │           │
                           Revise       Approve
                                          ↓
                                    Consolidate
                                          ↓
                                     Better Amy
```

### Phase 10 — Teaching layer (revised 2026-10; implemented, not yet live-verified - see `docs/growth-engine.md` §Phase 10)

Everything in Phases 6–9 captures what Amy *infers* from behavior, corrections, and tool outcomes. None of it covers direct instruction — the user deliberately showing or explaining a procedure. That path doesn't exist today (confirmed: zero references to "teach" anywhere in the codebase). Teaching is a new front door into the *same* Growth pipeline, not a parallel learning system — and critically, **not a skill-only pipeline**: a teaching session's lesson must pass through the same classification the rest of Growth uses before anything gets built, because not everything Amy is taught is a procedure.

```
Teaching Session (new) — one shared lifecycle for all three modes
    │
    ├── Demonstration      — user performs + narrates; captured like any other observation
    ├── Guided practice    — Amy attempts, user corrects; each correction = evidence
    └── Explain-and-build  — user describes procedure/rules/examples directly
             │
             ▼
     Capture: instructions + corrections + source references → teaching_sessions row
             │
             ▼
     classify_category()  ◄── same classifier Phase 6.3 already uses, not a new one
             │
    ┌────────┼────────────────┬──────────────────┐
    ▼                         ▼                   ▼
 Preference               Project knowledge     Skill
 (user/preference         (project decisions/   (repeatable procedure)
  system, not a skill)     learnings, not a skill)   │
                                                      ▼
                                      growth_proposals (category='skill',
                                      source='teaching_session')
                                                      │
                                                      ▼
                                      Learning Plan → Experiment
                                      (evaluate_skill_plausibility, or real
                                      test cases if the user gave expected
                                      inputs/outputs) → Evaluation
                                                      │
                                                      ▼
                                      Approval (growth_review, Tier 2 —
                                      same as any other skill proposal)
                                                      │
                                                      ▼
                                      Active skill, versioned, linked back
                                      to its originating teaching session
```

**Phase 10.1 — Teaching session record.** Add a `teaching_sessions` table to the existing `growth` database (not a new database): mode, source conversation/turn reference, captured instructions/corrections with references, extracted candidate procedure + rules + examples + unresolved questions, and a foreign key to whichever existing record it was classified into (`growth_proposals.id` for a skill outcome, or the preference/entities row for a non-skill outcome). This reuses `growth_proposals`/`learning_plans`/`experiments`/`evaluations` as the downstream pipeline — a teaching session is a new *source* feeding existing classification and consolidation, not a new lifecycle running alongside it.

**Phase 10.2 — Capture hook, shared across all three modes.** A teaching session starts the same way `behaviorFeedback`/`isCorrection` do today — detected mid-conversation (an explicit "let me show you how to do X" or "no, the right way is Y, here's why" pattern) rather than a separate mode the user has to invoke. Guided-practice corrections feed `record_observation` exactly like any other correction; the difference is they're pre-linked to one `teaching_sessions` row instead of accumulating as independent opportunities.

**Phase 10.3 — Classify before building anything.** Run the captured lesson through `classify_category()` before deciding what, if anything, to draft. A durable fact about how the user wants Amy to behave routes to the preference system, not a skill. A project-specific decision or constraint routes to project knowledge. Only a genuinely repeatable procedure becomes a skill candidate. This is the step that stops every teaching session from automatically producing a new skill.

**Phase 10.4 — Draft skill generation + testing** (skill-classified outcomes only). Explain-and-build sessions go straight from captured procedure to a draft skill body, then through the existing `evaluate_skill_plausibility` judge check before reaching `growth_review` — same `⚠️ LOW-CONFIDENCE` prefix convention Phase 6.5's follow-up work already established for low-scoring skill proposals. If the user supplied concrete example inputs/outputs during teaching, run those as real test cases (closer to golden-transcript regression than judge plausibility) rather than relying on the judge alone — this is the one place real execution testing is both cheap and available, since the test cases come from the teaching session itself.

**Phase 10.5 — Surface in Amy Lab.** Add teaching sessions as a view under the existing Growth → Learning Plans tab (linked session → classification → proposal/preference/knowledge record → plan → evaluation), rather than a sixth top-level tab. A teaching session is additional provenance on an existing record, not a new category of thing to triage.

### Phase 11 — Proof of learning (new 2026-10, the actual exit criterion for Phase 10)

A skill being saved and activated is not evidence Amy learned to use it. Before Teaching counts as done, add an end-to-end behavioral test, separate from the schema/pipeline tests above:

```
Teach a workflow → approve the resulting skill/preference/knowledge update
        ↓
Start a NEW, separate conversation
        ↓
Ask Amy to perform the same class of task with novel inputs
        ↓
Check:
  • Did she retrieve the right skill/preference/fact for this situation?
  • Did she follow the demonstrated procedure and respect its rules?
  • Did she avoid repeating the original mistake the teaching corrected?
  • Did she avoid firing on an unrelated request (false trigger)?
  • If something later contradicts or supersedes it, does she recognize that
    instead of applying stale guidance?
```

This is also where **provenance and lifecycle consistency** get enforced, not just recorded: every durable outcome should be traceable through stable IDs/links — which observation(s) → which teaching session → which proposal → which evaluation → who approved it → which active skill/preference/knowledge row resulted — using the existing tables' foreign keys, not copies of the same content. Superseded or contradicted information should be marked superseded (skill versioning and `persona_snapshots` already model this for skills/personas; extend the same pattern to teaching-derived preference and knowledge outcomes) rather than silently overwritten.

**Ongoing measurement**, added to the existing Amy Lab Growth dashboard rather than a new analytics subsystem — reuse `growth_history`, `evaluations`, and `review_scores`, which already exist for this purpose:
- Repeated-mistake rate (same `review_attributions` category recurring after a related proposal was consolidated).
- Skill retrieval/reuse success rate (a discovered skill was actually the relevant one for the turn).
- False-trigger rate (a skill fired on a turn its triggers shouldn't have matched).
- Proposals accepted / rejected / rolled back, by category.
- Corrections repeated on the same topic after Amy "learned" from an earlier one — the single clearest signal that a consolidation didn't actually change behavior.

The acceptance bar for this phase isn't "Teaching sessions produce skills." It's: **when Amy encounters a relevant situation, she retrieves the right information, applies it correctly, recognizes when it no longer applies, and demonstrates that a prior correction actually changed her later behavior.**

## 8. The autonomy model (resolves the open decision from §2/§4)

**Tier 1 — Autonomous.** Amy can do these without asking: research something, learn factual knowledge, create internal observations, run evaluations, create experiments, improve documentation, identify recurring problems, propose opportunities, maintain growth history.

**Tier 2 — User approval.** Ask before: activating a new skill, changing an established skill, changing user preferences, changing persona behavior, installing/adding capabilities, changing important workflows.

**Tier 3 — Always approval.** Never autonomously change: identity, core values, safety rules, permissions, tool access, destructive-action policies, security architecture.

This gives Amy a real drive toward growth without unrestricted self-modification. It directly resolves the "persona autonomy" and "Growth engine autonomy tier" open decisions from the original draft — the dormant `personas.proposed_system_prompt` path is Tier 2 (propose freely, always human-approved before promotion), never Tier 1.

## 9. Disposition of the old n8n self-improvement workflows

Keep `sijudgesub0001x.json`/`siproposer0001x.json`/`sireviewer0001x.json` and the `origin/worktree-self-improvement-cycle` branch as historical reference, but not operational:

```
96a56acd → extract validated design → new agent-service implementation → tests/evals → archive old branch/workflows
```

Archive only once Phase 6 is implemented and the schema/design has been ported and verified — keeps the repository clean without throwing away useful architectural history.

## 10. Target end-state architecture

```
                         AMY
                          │
             ┌────────────┴────────────┐
             │                         │
          RUNTIME                    GROWTH
             │                         │
      ┌──────┼───────┐         ┌──────┼───────┐
      │      │       │         │      │       │
   Memory Knowledge Skills  Learn  Experiments Eval
      │      │       │         │      │       │
      └──────┼───────┘         └──────┼───────┘
             │                         │
             ▼                         ▼
       Context Builder          Improvement Loop
             │                         │
             └──────────┬──────────────┘
                        ▼
                       AMY
```

Underneath: Postgres (operational state) · Memory Engine (episodic recall) · Knowledge Engine (semantic/world knowledge) · Graphiti (relationships, decisions, development history) · Skills (procedural capability) · Growth (determines what Amy should become better at) · Context Builder (determines what Amy needs right now).

## 11. Reconciling the 2026-10 "unified Memory, Skills, Teaching & Growth" proposal

A separately-drafted plan proposed treating memory, skills, teaching, and autonomous learning as one connected system, with capture/promotion kept as distinct steps. Checked against the live Phases 6–9 build (`docs/growth-engine.md`) rather than against this doc's own earlier (now-stale) "what's missing" framing. Short version: **the proposal's principles are already the system's principles — most of its "build this" items are already shipped under different names.** The one real, unbuilt layer is Teaching (now Phase 10, §7).

### Concept-by-concept verdict

| Proposal concept | Live equivalent | Verdict |
|---|---|---|
| Learning candidate (id, type, source, evidence, confidence, occurrence_count, status, destination) | `growth_observations` / `growth_opportunities` (`growth_db.py`) | **Already built**, near field-for-field match |
| Capture pipeline: signal → candidate → classify → route | `record_observation()` → `classify_category()` → `consolidate_proposal()` | **Already built** |
| Dedup + evidence accumulation | Dedup by normalized title; `frequency`/`last_observed_at` accumulate on match | **Already built**, simpler than proposed (title match, not semantic similarity — a real future refinement, not a gap) |
| Three-tier approval (autonomous / user-approval / always-approval) | `APPROVAL_TIER_BY_CATEGORY`, §8 of this doc | **Already built** |
| "Capture is not promotion" | Tier 2 proposals sit in `growth_proposals` until `growth_review` approval; nothing auto-applies to personas/skills | **Already built** |
| Golden-transcript regression before behavior changes | `check_golden_regression()` | **Already built** |
| Evaluation dimensions (task success, relevance, persona alignment, sentiment, follow-up coherence) | `growth_judge.py`'s 5-dimension rubric | **Already built**, identical dimensions |
| Learning Inbox / Growth dashboard | Amy Lab Growth tab — Overview / Opportunities / Review Queue / Learning Plans / History | **Already built**, live-verified via Playwright |
| Skill progressive loading (L1 metadata → L4 examples) | `skills_discovery.py`: L1/L2 always rendered, L3 for direct-trigger matches, L4 on-demand via `skill_examples` MCP tool | **Already built** |
| Graphiti milestones for meaningful consolidations, not every event | `growth_graphiti.py` fires only at `proposed`/`consolidated` | **Already built** |
| Durable, human-readable "library" (`amy-library/identity/`, `user/`, `projects/`, `skills/`, `growth/` as literal files) | Persona lives in Postgres (`personas.system_prompt`); user model lives in Honcho's hosted peer cards; skills live in the `skills` table | **Not built, and shouldn't be as literal files.** Introducing a filesystem tree as a second source of truth for data that's already authoritative in Postgres/Honcho is exactly the "parallel store for the same responsibility" this doc's own principles (and the proposal's own §14 non-goals) warn against. If a human-browsable view is wanted, build it as a generated export/read view over the existing stores, not a new place to write to. |
| Teaching (demonstration / guided practice / explain-and-build) | Nothing — zero matches for "teach" anywhere in the repo | **Real gap.** The only piece worth new engineering effort; see Phase 10 (§7). |
| Proof that a consolidated change actually altered behavior | Nothing — Phases 6–9 verify that a row got written, not that later turns behave differently | **Real gap.** See Phase 11 (§7) — a saved skill/preference is not evidence Amy learned to use it. |

### What to keep unchanged

The framing that matters most here: **stop treating memory/Growth as things to build, and start treating them as things to prove work together reliably.** Nothing below changes as a result of this reconciliation or the proposal:

| Decision | Keep as-is |
|---|---|
| Growth engine (observations → opportunities → proposals → plans → experiments → evaluations → consolidation) | Extend with Teaching as a new source; don't restructure |
| Skills v2 / progressive loading (L1–L4) | Keep |
| Context Builder | Keep; improve relevance selection with evidence from Phase 11's metrics, don't rewrite it |
| Honcho / Memory Engine / Knowledge Engine | Keep their distinct responsibilities; no merging into one store |
| Graphiti | Keep storing curated episodes at meaningful moments only, not raw turns |
| Postgres | Remains canonical for operational records, skills, and persona data |
| Filesystem-style "library" | Only ever a generated, human-readable view over the existing stores — never a second writable source of truth |
| Human approval (Tier 2/3) | Unchanged — persistent preferences, skill activation, persona changes, consequential capabilities all still require approval |

### What's actually left to do, in order

1. **Close the Review Queue gap first, and clear the pending persona proposal.** This is more than a UI fix — it's what makes self-modification auditable. The queue needs to show, per proposal: current version vs. proposed version with a readable diff, the rationale, the supporting observations/confidence/evaluation results that justified it, and a concrete description of what approving it will actually do.
   - **Done, 2026-10, not yet live-verified**: `growth_consolidate.preview_proposal` + `POST /growth/proposals/{id}/preview` generate the real candidate text and evaluation ahead of approval (reused, not regenerated, when the human then approves); the Review Queue and the legacy persona-proposal card both render a real diff. Full writeup in `docs/growth-engine.md`'s "Follow-up (2026-10)" section. Still needs: migration `28-add-proposal-preview-columns.sql` applied, and a real pass against the running stack — static checks (pyflakes/tsc/eslint) only so far.
   - **Still open, not code**: the real 2026-08-21 persona proposal (software-dev/GitHub capabilities) is visible via `growth_review`/`promote_persona` but still unreviewed by a human — shouldn't sit indefinitely.
2. **Build Phase 10 (Teaching)** as a workflow through the existing pipeline, not a third learning engine: one shared `teaching_sessions` lifecycle for all three modes, classification-first (so a preference or project decision doesn't get force-fit into a skill), reusing `growth_proposals`/`learning_plans`/`experiments`/`evaluations` as the downstream path.
   - **Done, 2026-10, not yet live-verified**: `teaching_sessions` table + `growth_teaching.finalize_teaching_session` (classify via `growth_judge.classify_teaching_content`, then route through the existing `record_observation`/proposal pipeline) + `teaching_session_manage` MCP tool as the capture hook (model-invoked, same precedent as `skill_propose` - deliberately not a `classify.py` structured-output schema change; full reasoning in `docs/growth-engine.md`). Amy Lab shows sessions under the Learning Plans tab. Still needed: apply migration `29-create-teaching-sessions-table.sql` and a real pass against the running stack.
3. **Prove end-to-end learning (Phase 11)** before calling Teaching done: draft generation, real skill execution, cross-conversation reuse with novel inputs, correct retrieval, rule adherence, no repeat of the original mistake, no false triggering on unrelated requests, and traceable provenance/supersession handling.
4. **Only then** address weaknesses that real measurement actually surfaces — semantic (not just title-match) deduplication, richer contradiction handling, retrieval tuning — rather than pre-building them speculatively. Add the small metric set to the existing Amy Lab dashboard (repeated-mistake rate, skill retrieval/reuse success, false-trigger rate, proposal accept/reject/rollback rates, corrections repeated after "learning") using `growth_history`/`evaluations`/`review_scores` — no new analytics subsystem.

**Acceptance criterion for this whole phase:** when Amy encounters a relevant situation, she retrieves the right information, applies it correctly, recognizes when it no longer applies, and demonstrates that a prior correction actually changed her later behavior. A schema existing, a proposal being approved, or a skill being saved are necessary steps toward that, not substitutes for it.

**Caveat before starting any of this:** everything marked "already built"/"live-verified" above reflects `docs/growth-engine.md` as written, not a fresh check of current code/test health. Verify the specific interfaces Phase 10/11 will touch (`growth_db.py`, `growth_judge.py`, `growth_consolidate.py`, the Amy Lab Review Queue component) actually still pass their existing tests before building on top of them.
