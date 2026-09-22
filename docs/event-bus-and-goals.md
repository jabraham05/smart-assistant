# Event bus + goals

Part of the [Smart Assistant](../README.md) project. See
[`docs/idle-reflection.md`](idle-reflection.md) for the autonomous workflow
that consumes this service's work-level gate and goals list.

**2026-08-05 — added because Amy had no persistent notion of the user's
ongoing objectives.** Goals like "track my job search" or "get to 10% body
fat" span weeks and need progress inferred from things that happen all over
the system (a Discord message, a completed coding task), not from the user
manually narrating status updates. `event-bus/` is a small, dedicated
Express+pg service (`docker-compose.yml`, port 3004, internal-only — no
published port, same tier as `sandbox-runner`) that owns three jobs: event
ingestion, deterministic classification, and deterministic keyword-based
goal matching.

**Deliberately no LLM anywhere in this service's hot path** (`classify.ts`'s
header comment). This session had already hit two separate incidents of the
local model failing to reliably hold instructions or converge on a
moderately complex task elsewhere in the project — classification and
goal-matching are exactly the wrong place to add a third dependency on that
same reasoning core. `classify.ts` is a plain `(source, type)` lookup table
deciding `priority`/`notify`; `goal-matching.ts` is plain substring
containment between an event's `type+source+payload` and each active goal's
keywords. This is a real, accepted v1 gap — it misses synonyms — not an
oversight.

**Data model** (`postgres/init/04-create-events-db.sql`, a dedicated
`events` database, same precedent as `research`/`n8n` being separate
databases): `events` (append-only audit trail — every ingested event is
recorded even when `classify.ts` decides not to notify on it), `goals`
(`title`, `description`, `keywords` JSONB, `status`
`active`/`done`/`abandoned`, `origin_session_id`), and append-only
`goal_progress_log` (only real keyword matches land here — the stale-nudge
below deliberately does not write to it, since a question isn't progress).
Since `postgres-data` already existed as a live volume before this file was
added, the init script doesn't auto-apply — same one-time manual migration
caveat as `research`'s (`02-create-research-db.sql`), commands documented at
the top of the SQL file itself.

**`goal_manage`** (new `skills-mcp` MCP tool,
`skills-mcp/src/tools/goal-manage.ts`) exposes `create`/`list`/`update`/
`progress` to Amy, calling `event-bus`'s REST API directly (no n8n hop —
unlike `code_task`'s webhook indirection, this has no legacy URL to keep
stable). Keywords are user-supplied or derived automatically from the
title/description (stopword-filtered word split, no embeddings). Progress
is never logged manually — `action='progress'` only ever shows real matched
activity.

**Producers wired in v1**: `discord-bot` publishes `discord.dm_received` on
every DM; `coding-orchestrator`'s `notifyOrigin` publishes
`coding_orchestrator.task_completed` / `task_needs_review` /
`task_resource_limit` alongside its existing chat/Honcho notify (own
try/catch — an unreachable event-bus must never affect the real notify
path); the dashboard-control workflow publishes `pi_dashboard.control_changed`.
All four default to `notify: false` in `classify.ts` — `coding-orchestrator`
and Discord already have their own synchronous user-facing notification, so
event-bus logging the same thing again would double the message, not add
value. The only thing event-bus itself notifies on in v1 is the goals
stale-nudge below — a deliberately conservative start, not a
general-purpose "everything pings you" firehose.

**Stale-goal nudge**: `n8n/workflows/goalsstalenudge1.json` is a daily
Schedule Trigger that does nothing but `POST` to `event-bus:3004/goals/nudge-check`
(`onError: continueRegularOutput`) — all real logic lives in
`event-bus/src/index.ts`, not n8n, on purpose. It finds goals whose
`goal_progress_log` has been quiet longer than `GOAL_STALE_DAYS` (env var,
default 7) and, for each one with an `origin_session_id`, sends a fixed
check-in message ("hasn't had any progress in a while — still working on
it, or should I mark it done/abandoned?") through the same `notifySession`
path `coding-orchestrator` uses (writes into `n8n_chat_histories`, plus
Honcho if `HONCHO_API_KEY` is set). It **never auto-changes a goal's
status** — it only ever asks a question back into the user's own session. A
goal with no `origin_session_id` is skipped, not force-notified nowhere.

**Verified live.** This system had actually been running unattended for a
full week (2026-08-05 through 2026-08-11) before ever being documented or
committed — real evidence, not a synthetic test: two real goals exist
("Job Search Tracker", "Target 10% Body Fat by New Year 2027"), both created
via real chat/Discord sessions; five real `goal_progress_log` matches were
recorded from real Discord DMs (e.g. "muscle", "weight loss" keyword hits);
`goalsstalenudge1` fired successfully every day for 7 consecutive days per
`n8n`'s own execution history. Neither goal happened to be stale during
that run (both were touched too recently to cross `GOAL_STALE_DAYS`), so the
notify path itself hadn't been proven — the run then went quiet for two
days (2026-08-12/13) because Docker Desktop wasn't running, not a bug in the
workflow. Re-verified 2026-08-13 after bringing the stack back up: by then
"Job Search Tracker" genuinely was stale (8 days untouched), and manually
invoking `/goals/nudge-check` correctly found it, delivered the real
check-in message into its origin session, and left its `status`/`updated_at`
untouched — closing the one previously-unproven path.

**Next up (not built)**: the nudge above is a fixed template regardless of
context. The natural next step is goal-completion detection (positive
reinforcement, not just staleness) and letting Amy's `user`→`amy` Honcho
directional card (see [`docs/persona-system.md`](persona-system.md)) shape
nudge tone/frequency — e.g. a "don't nag" trait should make her back off —
instead of one hardcoded string for everyone.

**2026-09-21 — added `GET /events` (list, newest first, optional
`?source=`/`?limit=`).** No read endpoint existed for the `events` audit
trail before this — every event was write-only, visible only via a raw
`psql` query. Added specifically to back `chat-ui`'s new event-bus
visibility panel (see [`docs/chat-ui.md`](chat-ui.md)) — a plain read of
`listRecentEvents`, no new access control, since this is a
debugging/observability surface on a single-user internal service, not a
consumer-facing API.

**Also not yet documented here**: `event-bus/src/calendar-watch.ts` (the
calendar poll-and-diff watcher, `CALENDAR_REMINDER_LEAD_MINUTES`/
`CALENDAR_POLL_LOOKAHEAD_HOURS`) shares this service but doesn't have a
write-up yet — a known gap, not a sign it's unused.

**2026-09-17 — first real automated tests in this project, not just manual
verification.** Every "verified" claim above (and across every other
`docs/*.md` file) was manual/live testing against the real stack — no
service in this project had a test suite at all until now. Started here
since `classify.ts`/`goal-matching.ts` are the two genuinely pure,
dependency-free pieces of logic anywhere in the project (per the "no LLM,
no I/O" note above), making them the cheapest place to get real unit-test
coverage. `goal-matching.ts`'s matching logic was inlined directly into
`matchEventToGoals` alongside its Postgres calls, with no pure function to
test in isolation — extracted `matchKeywords(goal, event): string[]` as a
small, testability-motivated refactor (`matchEventToGoals` is now a thin
wrapper that calls it, then does the DB writes). Uses Node's built-in test
runner (`node --import tsx --test src/*.test.ts`, `npm test`) — no new
dependency, since Node 22 (already required) ships it natively.
`tsconfig.json` excludes `*.test.ts` from the production build so test
files never end up in the Docker image's `dist/`. Deliberately narrow
scope for this first pass: `work-level.ts` (real Postgres queries) and the
`/idle-reflection-*`/`/goals/*` routes (real DB + HTTP) still have no
automated coverage — next candidates, once a pattern for testing
DB-touching code in this project exists.

## 2026-09-22 — TaskContext steps, relevant-goal injection, and the overnight digest

Part of the Coordinator work documented in full in
[`docs/chat-orchestrator.md`](chat-orchestrator.md)'s Coordinator section
(Phases 1b/4/6b) — this entry covers only what actually landed in
`event-bus` itself.

**Schema**: `task_contexts` (`postgres/init/11-create-task-contexts-table.sql`)
gained `facts`/`assumptions`/`unknowns` (JSONB, default `[]`) and
`next_action` (text) via `postgres/init/14-expand-task-context-fields.sql`.
New table `task_context_steps` (`id, task_context_id, step_index,
description, status [pending/running/completed/failed/blocked/skipped],
failure_policy [retry/recover/clarify/continue/skip/fail], tool_result
JSONB, timestamps`). New endpoints `POST /task-contexts/:id/steps` and
`GET`/`PATCH .../:id/steps/:stepId`, following the exact convention the
existing `/task-contexts/:id/log` endpoint already used.
`task_context_manage` (`skills-mcp`) gained `action: "plan"` (bulk-create
steps) and `action: "advance_step"` (update one step's status/tool_result/
failure_policy), alongside the existing `create`/`list`/`update`/`log`
actions.

**Relevant-goals injection**: `goal-matching.ts` gained
`matchGoalsToText(text, goals)`, reusing the same deterministic keyword
matching that already auto-logs `goal_progress_log` entries — now also
called on every chat turn so any active goal whose keywords match the
current message gets a one-line summary (title + status) injected into
`chat-orchestrator`'s context. Independent of `memoryPolicy`, same
reasoning as open-TaskContext visibility below: a stated objective is
directly actionable state, not ambient personalization — but naturally
self-limiting, since only genuinely keyword-matching goals surface, not
every open goal every turn.

**Overnight digest + calendar-triggered wake-up** (`src/digest.ts`'s
`runOvernightDigest`, `src/calendar-watch.ts`'s `isWakeEvent`): lives here
because it's a direct extension of this service's existing
calendar-poll-and-diff and `notifySession`/`notifyOwnerDirect`
infrastructure, not a new service. `research_task` completions classified
`background: true` get deferred (tagged `awaiting_digest` in `events`
instead of an immediate notify); `isWakeEvent` is a plain
case-insensitive "wake" keyword match checked wherever
`event_starting_soon` already fires, triggered off the user's own
recurring "Wake Up" calendar event rather than a fixed clock time. The
digest bundles deferred completions plus a two-query (global + US)
`web_search` news pass (one small LLM call to synthesize the two into a
short digest — the one appropriately-LLM piece in this otherwise
deterministic pipeline) into a single Discord DM via
`discord-notify.ts`'s `notifyOwnerDirect`, gated by the same
`canMessageUser` cooldown pattern `idle-reflection` already uses so a
repeated poll cycle can't double-send. `GET/POST /overnight-digest-check`
and `/calendar/poll-check` expose this for manual/scheduled firing.

**Real per-step narration** (Phase 6b): `src/step-notifications.ts`'s
`stepTransitionNotification` (pure, unit-tested in
`step-notifications.test.ts` — extracted to its own file specifically so
it could be imported without triggering `index.ts`'s `app.listen()`
side-effect) decides when a step transition is worth telling the user
about: `failed`/`blocked` notify immediately, `completed` only once
**every** step in the plan is done (a `skipped` step counts as done for
that check), `pending`/`running` transitions never notify. Wired into the
step-update endpoint, reusing `notify.ts`'s existing `notifySession` —
same delivery path `coding-orchestrator`'s task-completion notify and the
stale-goal nudge already use.

**Real bug fixed, found via live testing, not a unit test**: `PATCH
/task-contexts/:id/steps/:stepId` compared `task_context_id` with strict
`!==` against a parsed `Number`, but `node-pg` returns `BIGINT` columns as
JS strings — the comparison always failed, so `advance_step` reported
failure back to the model even when the underlying `UPDATE` succeeded.
Fixed with `Number(updated.task_context_id) !== taskContextId` on both
sides of the check.

## 2026-09-22 — event-bus's two hooks into the self-learning research queue

Full design/verification in [`docs/knowledge-engine.md`](knowledge-engine.md)'s
own dated entry — this covers only the two things that actually live here.

**`POST /goals`** (deterministic backstop): after a goal is created, a
fire-and-forget call to knowledge-engine's `POST /research-queue` seeds a
queue entry from the goal's own title (`triggerSource: 'goal_created'`),
after the HTTP response already went out — a slow/unreachable
knowledge-engine must never delay or break goal creation itself.

**`POST /calendar/poll-check`**: alongside the existing
`runOvernightDigest` call on a detected wake event, now also calls
`drainResearchQueueIfIdle` — gated on `getWorkLevel(config)` exactly like
`/idle-reflection-check` already is (skips draining, same as idle-reflection
skips its own reasoning pass, whenever a coding task or research session is
already running). `POST /research-queue-check` is the standalone manual
test entry point for this gate specifically (knowledge-engine's own `POST
/research-queue/drain`, which this calls, has no work-level awareness of
its own — that check only makes sense here, where `getWorkLevel` already
lives).

New config: `knowledgeEngineUrl` (`KNOWLEDGE_ENGINE_URL`, default
`http://knowledge-engine:3005`) — confirmed absent from this service's
config before this, only `skillsMcpUrl` existed as a cross-service URL
here previously.
