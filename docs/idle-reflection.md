# `idle_reflection` (autonomous proactive check-in, work-level- and cooldown-gated)

Part of the [Smart Assistant](../README.md) project. See
[`docs/event-bus-and-goals.md`](event-bus-and-goals.md) for the service
backing its work-level/cooldown gates and goals list, and
[`docs/skill-gap-scanner.md`](skill-gap-scanner.md) for the sibling
autonomous workflow it mirrors.

A second autonomous n8n workflow alongside `skill_gap_scanner`
(see [`docs/skill-gap-scanner.md`](skill-gap-scanner.md)), on its
own `Schedule Trigger` (every 30 minutes) — but where `skill_gap_scanner`
only ever writes a reviewable proposal, `idle_reflection` can also choose to
message the user directly, so it's gated far more conservatively.

Two deterministic gates live in `event-bus`, not the LLM
(`POST /idle-reflection-check`, `event-bus/src/index.ts`): `shouldReflect`
is false whenever `getWorkLevel` (`event-bus/src/work-level.ts`) reports
`"high"` — a coding task or research task is actually running, checked
directly against `coding_tasks`/`research_documents` row status, not
inferred — and otherwise true once `IDLE_REFLECTION_MIN_HOURS` (default 4)
have passed since the last reflection. `canMessageUser` is a separate,
stricter cooldown (`IDLE_REFLECTION_MESSAGE_MIN_HOURS`, default 24) that
only ever advances via `POST /idle-reflection-messaged`, called by the
workflow at the moment it actually publishes a message — so a tick that
decides *not* to message never consumes the cooldown.

When `shouldReflect` is true, the workflow queries Honcho's dialectic
endpoint plus the user's active goals (`GET /goals?status=active`) and asks
Ollama (`qwen3:8b`, structured output) to pick one of three actions:
`propose_skill` (queue a reviewable proposal — the default, low-cost
outcome), `message_user` (interrupt the user right now — reserved for
something concretely tied to an active goal, only actually sent if
`canMessageUser` is true), or `skip`. A `message_user` decision made while
`canMessageUser` is false is converted into a `propose_skill` instead of
being silently dropped, so a genuinely good idea still reaches a human, just
not synchronously.

**2026-09-03 — added a semantic dedup check before proposing**, mirroring
`skill_gap_scanner`'s own `Semantic Dedup Check`
(see [`docs/skill-gap-scanner.md`](skill-gap-scanner.md)): fetches every
existing skill (`Get All Skills`, any status) and asks a dedicated Ollama
call whether the new candidate duplicates one in substance, not wording,
before it ever reaches `Submit Proposal`. Without this, idle reflection had
no way to notice it had already proposed the same idea on an earlier tick —
the workflow otherwise carries no memory of its own past proposals beyond
whatever is already sitting in the `skills` table.

**Still n8n-only, confirmed 2026-10-13**: checked this doc directly against
the current export (`n8n/workflows/idlereflection0001.json`, `active:
true`) — its 19 nodes match this description exactly (`Schedule Trigger`,
`Check Idle Reflection`, `If Should Reflect`, the Honcho/goals fetch, the
Ollama reasoning + parse, the `propose_skill`/`message_user`/`skip`
branches, `Can Message User Now`, `Publish Proactive Thought`, `Mark
Messaged`, the semantic dedup chain). This logic has **not** moved into
`event-bus` or `chat-orchestrator` — it's still exactly this n8n workflow
calling out to `event-bus`'s gates, same as always. The one thing worth
not confusing it with: `agent-service`'s separate Growth engine background
loop (`growth_background.py`, see
[`docs/growth-engine.md`](growth-engine.md) Phase 9) deliberately runs on
the same 30-minute cadence and is also gated/observation-driven, but it's
a distinct mechanism with a distinct job — it judges past turns into
`growth_observations`/proposals and never messages the user directly
(Tier 1 only, always routed through human review in `growth_review`). Two
independent 30-minute loops exist side by side on purpose, not because one
superseded the other.
