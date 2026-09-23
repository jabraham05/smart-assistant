# `chat-orchestrator` — self-hosted tool-calling for Chat, replacing n8n's AI Agent

Part of the [Smart Assistant](../README.md) project. See
[`docs/chat-workflow.md`](chat-workflow.md) for the n8n workflow this
replaces (kept published as a rollback, not deleted) and
[`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md) for the
raw-Ollama-tool-loop pattern this reuses.

**2026-09-21 — built because n8n's `AI Agent` + `MCP Client Tool` node is
the one integration in this whole project with an extensive, unresolved
history of `qwen3:8b` tool-calling failures** (see
[`docs/chat-workflow.md`](chat-workflow.md)'s and
[`docs/persona-system.md`](persona-system.md)'s documented history: empty
completions, self-contradictory reasoning that never emits a call, leaked
internal tool/node names, and `skill_propose`'s own irreducible
invocation gap). `coding-orchestrator` and `knowledge-engine`'s research
agent had already independently proven a raw Ollama `/api/chat`
tool-calling loop reliable for this exact model — this ports that same
proven pattern to Chat, via a real MCP client against `skills-mcp`
(itself completely unchanged — it was already a correctly-separated,
standalone MCP server; this is just a second, better-behaved consumer of
it).

**Root cause, precisely** (this determined what got ported vs. dropped):
`docs/chat-workflow.md` documents a real, controlled, client-independent
finding that `qwen3:8b` itself gets measurably worse at tool selection as
bound tool count grows (0/3 success with 6 tools bound vs. 3/3 with 1,
tested via `ollama-mcp-bridge` bypassing n8n entirely, and via n8n's
native path — same result either way). `coding-orchestrator`'s own
raw-HTTP validation only ever tested 2 tools, so it's consistent with
this, not a contradiction of it. Separately, two genuinely n8n-specific
bugs stack on top: the `MCP Client Tool` node prefixes tool names with
its own node display name, silently breaking `qwen3:8b`'s tool-calling
grammar once the combined name crosses ~5-6 segments
([`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md)); and
`lmChatOllama` loses the `tool_calls` field whenever a response carries a
`thinking` block. Moving off n8n's integration removes the two
n8n-specific bugs, but **not** the underlying tool-count ceiling — the
dynamic tool-group classifier is ported forward deliberately, not
dropped.

## Architecture

New service, `chat-orchestrator/` (Node/Express, same shape as
`coding-orchestrator/`/`knowledge-engine/`). Preserves the exact wire
contract both real clients (`chat-ui`, `discord-bot`) already parse:
`POST /webhook` with `{chatInput, sessionId}`, NDJSON stream out
(`{type: "begin"|"item"|"end"|"error", content?, metadata: {nodeId,
nodeName, itemIndex, runIndex, timestamp}}`), reply text always carrying
the literal `metadata.nodeName: "AI Agent"` both clients already key off
of. This is why the client cutover needed **zero code changes** in either
`chat-ui` or `discord-bot` — only their webhook URL env var moved.

Per-turn pipeline (`src/index.ts`):

1. Fire-and-forget event to `event-bus` (`src/events.ts`).
2. **Tool-group classification** (`src/classify-tools.ts`) — ported
   near-verbatim from the old `Classify Relevant Tool Groups`/
   `Expand Groups To Tools` nodes: same category list, same `GROUPS`
   mapping, same raw-Ollama structured-output call. `calculate` always
   included. Kept because it's mitigating the real tool-count ceiling
   above, not an n8n-specific workaround.
3. **Persona + active instruction skills** (`src/db.ts`,
   `src/skills-catalog.ts`) — direct Postgres reads against a
   schema-configurable view (`CHAT_DB_SCHEMA`: `public` in production,
   `chat_test` for the side-by-side test instance — see
   `postgres/init/10-add-chat-test-schema.sql`). Read-only: approving a
   skill or editing a persona still happens exactly where it does today,
   in n8n's Data Table UI (or directly via SQL in `chat_test` while
   trying something out).
4. **Honcho calls** (`src/honcho.ts`) — ported verbatim: ensure session,
   set `observe_others` on peer `user`, get `user`'s card, get `user`'s
   card `target=amy`. Same workspace as production n8n
   (`smart-assistant`) for both the prod and test instance — a known,
   accepted limitation (see below).
5. **System prompt assembly** (`src/system-prompt.ts`) — same shape as
   the old `AI Agent.systemMessage` expression: persona + Pacific-time
   date injection + user card + user-for-amy card + skills catalog, each
   clause degrading to empty string if its source is missing.
6. **Raw Ollama tool-calling loop** (`src/agent-loop.ts`) — the exact
   `coding-orchestrator/src/agent-loop.ts` shape (structural
   `message.tool_calls` detection, `trimHistoryToBudget`/
   `truncateToolResult`), extended to accept short-term conversation
   history as a permanently-protected block ahead of the current
   turn, and to report which tools were actually called each iteration
   (`onToolCalls`) so the safety net below can check real behavior, not
   just the final text. Tools come from a real MCP client
   (`src/mcp-client.ts`, `@modelcontextprotocol/sdk`) connected to
   `http://skills-mcp:3001/mcp?chatSessionId=...` — same endpoint and
   same session-correlation query param the old `MCP Client Tool` node
   used — filtered to the classified subset from step 2.
7. **Minimal safety net** (`src/safety-net.ts`) — only the
   mechanism-independent checks survive from the old `Detect Garbage
   Output` node. The old regex zoo (leaked MCP error strings, leaked
   internal node/tool names, fake tool-call JSON blobs, "function call"
   narration) was specifically symptomatic of the two n8n bugs this
   migration removes — a structurally-detected `tool_calls` response
   can't produce those shapes. What's kept: one-shot empty-output retry
   (mirrors `coding-orchestrator`'s own retry), one-shot
   unfulfilled-search-intent retry (model narrates "let me search..."
   without an actual search tool call), and a one-shot confabulated-action
   retry (model claims "I've scheduled that" with no matching tool call).
8. **Persist**: Honcho (`peer_id: 'user'`/`'amy'`, same as before) and the
   service's own Redis-backed short-term buffer (`src/session-memory.ts`,
   `REDIS_DB`: `0` prod / `1` test) — replaces n8n's Postgres Chat Memory
   for chat specifically. Neither `chat-ui` nor `discord-bot` ever read
   `n8n_chat_histories` directly (confirmed: it was purely internal to the
   old `AI Agent`'s own prompt construction), so retiring it for chat had
   no client-visible effect.

## Test/production separation

Two docker-compose services from the same image, differing only by env
var: `chat-orchestrator` (prod, host port 3008 → container 3006) and
`chat-orchestrator-test` (host port 3009 → container 3006). No
per-request flag, no shared mutable state. `REDIS_DB` keeps session
buffers from colliding; `CHAT_DB_SCHEMA` points persona/skills reads at
either the real views onto n8n's live Data Tables or the plain
`chat_test.personas`/`chat_test.skills` tables a human can freely edit via
SQL to try a change safely before promoting it into the real n8n Data
Table via the UI.

**Known, accepted limitation**: both instances share one real Honcho
workspace, `skills-mcp`, and Ollama. A test-mode conversation still
writes to Amy's real long-term Honcho memory, and a real tool call
(schedule a calendar event, control Spotify) still performs the real
action — not sandboxed by this design, deliberately out of scope for this
phase.

## Verified live (2026-09-21)

Against the real running stack, not just the 21 unit tests covering the
pure/deterministic pieces (`classify-tools`, `safety-net`, `agent-loop`'s
trim/truncate, `skills-catalog`, `system-prompt`):

- Plain greeting, zero tools bound.
- A real `weather_get` tool call (single tool) — genuine Open-Meteo data
  back through the model, not confabulated.
- A combined `calculate` + `weather_get` call in **one turn** (two-group
  classification, `qwen3:8b` correctly emitting two simultaneous
  `tool_calls`).
- Multi-turn Redis session memory recall ("my favorite number is 42" →
  "what's my favorite number?" correctly answered "42" in a fresh
  process/session two calls later).
- Test/prod isolation: edited `chat_test.personas` alone (a literal
  `TESTMODE` marker), confirmed `chat-orchestrator-test` reflected it
  while `chat-orchestrator` (prod) and the real n8n persona stayed
  exactly unchanged.
- **Client cutover**: `chat-ui`'s real `/api/chat` route and
  `discord-bot` both repointed at `chat-orchestrator` (prod) via env var
  only, zero code changes. `chat-ui`'s route round-tripped a real
  `calculate` tool call end-to-end through the new backend; `discord-bot`
  reconnected to Discord's gateway cleanly under the new URL.

## What's explicitly NOT changing (yet)

- **n8n itself is not being retired.** It still runs 10 other active
  workflows unrelated to this migration: `calendar_watch`,
  `coding_task_orchestrator_proxy`, `dashboard_control`,
  `dashboard_state`, `goals_stale_nudge`, `idle_reflection`,
  `minimal_agent_test`, `skill_gap_scanner`, `skill_proposal_intake` (the
  actual webhook target `skill_propose` posts to), and `spotify_action`.
  Confirmed directly against the live `workflow_entity` table
  (`active = true` for all of these) before writing this section.
- **The old `Chat` workflow is deliberately still published**, as the
  literal instant rollback: reverting `chat-ui`/`discord-bot`'s webhook
  URL env var back to
  `http://n8n:5678/webhook/370d9565-997b-4121-aca7-1128df3dc4ea/chat` is
  the entire rollback procedure, with no import/publish cycle needed.
  `coding-orchestrator`'s and `event-bus`'s direct writes into
  `n8n_chat_histories` (via `notifySession`, see
  [`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md) and
  [`docs/event-bus-and-goals.md`](event-bus-and-goals.md)) are **also**
  deliberately still in place for the same reason — removing them now
  would let the rollback path's own conversation memory silently go
  stale from the moment of cutover onward. **Revisit trigger**: once
  `chat-orchestrator` has had a real soak period with no regressions, at
  which point unpublishing `Chat` (same `unpublish:workflow` +
  `webhook_entity` cleanup procedure already used for `research_pipeline`/
  `coding_task_pipeline`, see
  [`docs/known-gotchas.md`](known-gotchas.md)) and removing the
  `n8n_chat_histories` dual-writes become safe, not premature.
- `skills-mcp` — unchanged; now a shared tool host for three consumers
  (`coding-orchestrator`, `knowledge-engine`, `chat-orchestrator`) instead
  of two.

## 2026-09-22 — Coordinator: classification drives tool/memory/planning policy, not just tool groups

`chat-orchestrator` merged to `main` (Phase -1 of the plan below) shortly
after the section above was written. Everything from here documents a
second, larger project built directly on top of it: turning
`classify-tools.ts`'s one-purpose tool-group classifier into a full
**Coordinator** that also decides, per message, whether a tool call is
mandatory, whether memory should be searched, whether the message needs a
real multi-step plan, and whether it should run in the background — all
enforced in code, not left to the prompt. Full design record:
`~/.claude/plans/bubbly-bouncing-starfish.md` (the user's own architecture
doc, phased and discussed before any of this was built). Built and
live-verified phase by phase against real Discord/`chat-ui` traffic, not
just unit tests.

**Phase 0 — eval harness.** `scripts/eval-harness.mjs` +
`scripts/eval-fixtures/v0-baseline.json` fire real messages at
`chat-orchestrator`'s live `/webhook` and record `relevantGroups`,
retry-flag firings, latency — a real before/after baseline every phase
below diffs against, rather than trusting "it feels the same."

**Phase 1 — Coordinator schema.** `classify-tools.ts`'s existing
structured-output Ollama call now returns `toolPolicy`
(`required`/`optional`), `memoryPolicy`
(`none`/`optional`/`relevant`/`required`), `needsPlanning` (bool), and
`background` (bool), alongside the original `capabilities` array.
**Deliberately no `executionMode` enum** — the original design doc
proposed one (fast/tool_required/plan/research/overnight), but a single
mode enum forces a false choice on a message that genuinely needs research
*and* planning at once; four independent flags, each driving exactly one
real behavior, don't have that problem. `background: true` force-includes
`research_task`/`research_task_status` in the bound tool list, the same
always-on pattern `calculate` and `task_context_manage` already used.

**Phase 1b — overnight digest + calendar-triggered wake-up.**
`event-bus/src/digest.ts`'s `runOvernightDigest`, triggered off
`event-bus/src/calendar-watch.ts`'s `isWakeEvent` (a plain case-insensitive
"wake" keyword match against `event_starting_soon` detections — no cron,
the user's own recurring "Wake Up" calendar event is the trigger).
`research_task` completions classified `background: true` get tagged
`awaiting_digest` instead of notifying immediately (`deferNotify`); the
digest bundles those plus a two-query (global + US) `web_search`
news-and-synthesis pass into one consolidated Discord DM via
`event-bus/src/discord-notify.ts`'s existing `notifyOwnerDirect`, gated by
the same `canMessageUser` cooldown pattern `idle-reflection` already uses
so a re-poll can't double-send.

**Phase 2 — tool policy enforcement.** `safety-net.ts` gained
`hasUnsatisfiedRequiredTool(toolPolicy, calledTools, boundActionTools)`,
wired into the same one-shot-retry mechanism `hasUnfulfilledSearchIntent`/
`isConfabulatedAction` already used — no new retry infrastructure. If
`toolPolicy === 'required'` and the retry still comes back without any
bound action tool called, the response is a **fixed template string**
("I wasn't able to complete that using my tools just now — want me to try
again?"), never the model's own text — the model is never allowed to
generate its own "I failed" message, since that's exactly the shape that
can still confabulate.

**Phase 3 — `memory_policy` gating + new `memory-engine` service.** See
[`docs/memory-engine.md`](memory-engine.md) for the new service itself.
`memoryPolicy` now throttles Honcho peer-card injection and
`session-memory.ts`'s Redis turn-history window (`none` caps it low,
`optional` keeps current behavior); `relevant`/`required` force-include
`memory_recall` in the bound tool list even without `personal` classified,
mirroring Phase 1's `research_task` force-include.

**Phase 3b — memory-engine metadata + a reverted synthesis step.**
`domain`/`task_context_id` columns added to `memory_entries` at ingest, so
`/search` can optionally scope retrieval to one topic or one open task's
own history. **An LLM-based compact-summary synthesis step
(`memory-engine/src/synthesize.ts`) was built, then removed entirely**
per direct user feedback: *"I don't think llm is needed for this memory
engine but it should be classifications, relevance ranks and such."*
Real, measured cost of the reversal: `memory_recall`'s response time
dropped from several seconds (with synthesis) to **71ms** (plain ranked
results). This is now the standing principle for `memory-engine` — see
that doc's own note on it.

**Phase 4 — TaskContext expansion + goals/tasks context injection.**
`task_contexts` gained `facts`/`assumptions`/`unknowns`/`next_action`; new
`task_context_steps` table (`step_index`, `description`, `status`,
`failure_policy`, `tool_result`); `task_context_manage` gained
`action: "plan"` (bulk-create steps) and `action: "advance_step"`. Any open
task context, and any active goal whose keywords match the current message
(`goal-matching.ts`'s new `matchGoalsToText`, reusing the same deterministic
matcher that already auto-logs goal progress), get injected into
`system-prompt.ts`'s context **unconditionally, independent of
`memoryPolicy`** — both are directly actionable state the model needs
regardless of this turn's memory-relevance classification, not ambient
personalization. See [`docs/event-bus-and-goals.md`](event-bus-and-goals.md)
for the schema/endpoint detail.

**Phase 5 — deterministic post-tool verification.** New registry,
`skills-mcp/src/lib/verify-tool-result.ts` (args + result →
`{ok, reason?}`), called from inside each tool's own handler right before
returning. Wired into `calendar_event.ts` (compares requested vs. actual
Google Calendar response fields) and `task_context_manage.ts` (checks
objective/step-count/step-status actually match the request). Verification
results land in `task_context_steps.tool_result` via an auto-resolved
`activeTaskContextId` threaded through `RequestContext`
(`skills-mcp/src/server.ts`) — the model never has to pass a task ID
explicitly, removing a confabulation surface.

**Phase 6 — streaming/progress narration.** **6a**: a prompt-only nudge
(`narrateBeforeSlowAnswer` in `system-prompt.ts`), gated on
`needsPlanning`/background research, telling the model to briefly narrate
before a slower answer. **6b**: real per-step Discord/session
notifications once a plan's steps exist, via `event-bus/src/notify.ts`'s
existing `notifySession`, filtered by the new, unit-tested
`event-bus/src/step-notifications.ts`'s `stepTransitionNotification` —
`failed`/`blocked` notify immediately, `completed` only notifies once
**every** step in the plan is done (skipped steps count as done for that
check), `pending`/`running` never notify. Deliberately narrow: notifying on
every intermediate step would be noise for a plan the user isn't actively
watching.

### Real bugs found and fixed via live testing (not caught by unit tests)

- **`task_context_manage` was never registered on `main` at all.** The
  entire original TaskContext feature had only ever existed on the
  `worktree-knowledge-engine` branch — a merge-time fix never got
  cherry-picked into `skills-mcp/src/server.ts`. Root-caused by diffing the
  worktree's `server.ts` against `main`'s and copying the two missing
  lines directly.
- **BIGINT-vs-Number comparison bug.** `PATCH
  /task-contexts/:id/steps/:stepId` compared `task_context_id` via strict
  `!==` against a parsed `Number`, but Postgres `BIGINT` columns come back
  from `node-pg` as JS strings — the comparison always failed, so
  `advance_step` silently reported failure even when the underlying
  `UPDATE` succeeded. Fixed with `Number(updated.task_context_id) !==
  taskContextId`. Found via live Discord testing, not a unit test.
- **Classifier misclassification, reported live via Discord**: "do you
  have my Porsche manual" classified `info` instead of `knowledge` because
  the two category descriptions in `CLASSIFIER_SYSTEM_PROMPT` were too
  similar. Fixed by rewriting the prompt to explicitly exclude documents/
  manuals/reference material from `info` and adding explicit `knowledge`
  examples ("do you have the manual for my car", "what does the guide say
  about X"). Verified 6/6 consistent runs afterward (previously variable).
- **Second-layer bug, same root cause, one level deeper**: even once
  classification was fixed, the model still called `memory_recall` instead
  of `knowledge_search` because of the possessive phrasing ("**my**
  manual"). Fixed via an explicit exclusion added to `memory-recall.ts`'s
  own tool description ("Do NOT use this for a document, manual, or guide,
  even when the user phrases it possessively"). Verified live: real manual
  excerpts (seat memory settings, tire pressure, fuel tank capacity)
  returned correctly through Discord afterward.

### 2026-09-22 — self-learning research queue: `knowledgeGapTopic`

`classify-tools.ts`'s classification call (the same one from Phase 1, no
new LLM call) gained a fifth field: `knowledgeGapTopic: string | null` — a
short topic string when the message reveals a genuine ongoing interest Amy
likely knows little about, extracted for the new research-queue system
(full design in [`docs/knowledge-engine.md`](knowledge-engine.md)'s own
dated entry). When non-null, `index.ts` fire-and-forget enqueues it to
knowledge-engine's `POST /research-queue` — never blocks the reply, never
gates tool binding the way the other four fields do. Built alongside a
prompting-only fix to the `'goals'` category description (broadened beyond
job-search/fitness/savings to cover new hobby/technical/creative
projects) and `goal_manage`'s own tool description, since the real gap
that surfaced this ("I have a new project idea of building a robotics
arm") was two separate misses at once — neither tracked as a goal nor
recognized as worth researching. Verified live: the exact message above
now creates a real goal **and** queues the topic in the same turn.

### 2026-09-22 — classifier grounding + a standing response-style rule

Two compounding bugs found in one live test: asking "so the robotic arm
what have you found" classified `goals` instead of `research` (a
similarly-named goal existed, pulling the classification toward it), so
`research_task_status` was never bound and the model answered from
memory-engine fragments and its own training knowledge instead of the
real findings. Fixed by making `CLASSIFIER_SYSTEM_PROMPT`'s `'research'`
category description explicit that a findings/progress-check message
should include `'research'` even when the same topic also matches an
existing goal — the two aren't mutually exclusive.

Separately, `system-prompt.ts` gained a standing, always-on response-style
rule (concise by default, consolidate rather than list, full detail only
on request, mention a `documentUrl` when a tool result includes one) —
not conditional on this turn, since dumping raw tool output instead of
synthesizing it isn't specific to research. See
[`docs/chat-ui.md`](chat-ui.md)'s new dated entry for the other half:
once real findings *were* being retrieved, a live re-test showed prompt
guidance alone wasn't enough to stop the model pasting all of them
verbatim anyway, so `research_task_status` now deterministically caps how
many findings it ever hands the model, rather than trusting it to
self-limit.

### Known rough edges, not yet fixed

- `dashboard_control`'s 90–107s latency outlier — flagged repeatedly during
  Phase 0–6 testing, never root-caused.
- `task_context_manage` is excluded from `toolPolicy: required`'s
  bound-tool counting (it's always-on, not gated by capability
  classification) — this can cause a false-positive enforcement retry when
  the model reasonably checks task state before answering. Not fixed.
- Phase 7 (deterministic-only confidence/supersession refinement for
  `memory-engine`) and Phase 8 (sub-workflow decomposition) remain tabled
  pending real evidence of need — see the plan doc.
- The n8n `Chat` workflow is still published as the literal rollback path
  (see "What's explicitly NOT changing (yet)" above) — task #59
  (leaked-tool-call recovery) stays open until that rollback path is
  formally retired, even though the failure class it recovers from can't
  occur in `chat-orchestrator`'s own architecture.

### 2026-09-22 — a real fix stranded on a branch, and where it actually needed to land

A separate commit, `97e7a99` ("Fix three real production bugs found via
live user testing" — calendar `list`'s missing date validation, a
shopping/product-lookup classifier gap, and a `z.coerce.number()` fix
across five `skills-mcp` tool schemas), existed only on the
`worktree-knowledge-engine` branch and had never been merged into `main`
— found via a cherry-pick conflict, not reported. Brought in directly.
One piece needed a second fix on top: that commit's classifier widening
("look up earring for men and give me some links amazon" classifying to
zero capabilities, so `web_search` never got bound) only ever touched the
old n8n `Chat` workflow's own classifier prompt — the rollback path, not
live traffic. `chat-orchestrator/src/classify-tools.ts` is what actually
serves real messages and never received the fix, so the bug was still
live. Same widening ported here. Verified live: the exact original
message now correctly binds `web_search`.

### 2026-09-22 — feedback-capture: the first building block of Amy's self-improvement loop

Not "projects" (see `docs/knowledge-engine.md`'s dated entry) - a
different, smaller piece the user asked for right after that shipped:
before any investigation/experiment/consolidation machinery can exist for
behavioral self-improvement, the raw signal needs to be captured
reliably. Nothing captured it before this.

Extended the Coordinator's existing per-turn classification call (same
mechanical pattern as `knowledgeGapTopic` from the research-queue work -
no new LLM call) with `behaviorFeedbackCategory`/`behaviorFeedbackNote`,
combined into `ClassificationResult.behaviorFeedback: {category, note} |
null`. Fires ONLY when the user describes a *repeated pattern* in Amy's
own behavior ("you keep giving me too much detail", "you have trouble
remembering our past conversations") - explicitly not a one-off
correction to the current turn (those stay `null`; the prompt gives both
positive and negative examples). `category` is one of `communication` /
`tool_selection` / `memory_retrieval` / `planning` / `proactivity` /
`other`. When set, `index.ts` fire-and-forgets a `behavior_feedback`
event to event-bus's plain `events` table via a new
`publishBehaviorFeedbackEvent` (`events.ts`) - deliberately no new table;
this is exactly the "raw, append-only record" tier, nothing more, until
there's a second real signal source to justify more structure.

**Real false positive found via live testing, fixed same session**: the
first test (`node scripts/chat.mjs` reusing one persisted `cli-*` session
id) sent real feedback ("you always give me way too much detail..."),
then an unrelated follow-up ("what's 15 times 6") - and the classifier
re-emitted the *same* feedback note on the unrelated turn, pulled from
the `recentContext` field the classifier is also given (for resolving
anaphoric follow-ups like "fix that"). The prompt didn't say this field
should ignore prior context, so the model happily carried it forward.
Fixed by adding an explicit line: base `behaviorFeedback` only on the
current message, never the prior exchange, even if the prior exchange had
real feedback. Re-tested the identical two-message sequence live:
feedback captured once, the unrelated follow-up produced no event.

**Consumption**: none yet, deliberately - this only captures the signal.
A read-only "Feedback" card was added to chat-ui's `/amy` page (see
`docs/chat-ui.md`) so it's actually visible, but no
investigation/experiment/consolidation loop reads it automatically. That
loop is real, wanted future work - not built until this capture path has
some real data behind it.

### 2026-09-24 — more real bugs from live dogfooding: silent non-action, and giving up instead of retrying

Two more findings from the same dogfooding sessions as `docs/knowledge-engine.md`'s dated entry, both in the safety net:

**`task_context_manage` had two real gaps in `safety-net.ts`**, both from the same root cause: it's always bound (`ALWAYS_BOUND_TOOLS`), so neither existing check ever really covered it.
1. Missing from `ACTION_TOOLS` - "I've created a task for X" with no real call slipped past confabulation detection entirely, since `hadActionToolBound` was false whenever nothing else got classified this turn (a real reported symptom: *"she would also just say she'll keep some things in mind but won't actually create the task... just talks about it"*).
2. `hasUnsatisfiedRequiredTool` unconditionally returned `false` whenever the only bound tools were the always-bound ones - task creation has no classifier category of its own, so this was *every* task-creation turn, with zero deterministic backstop. Fixed by special-casing `task_context_manage`: if it's bound, `toolPolicy='required'`, and it was never called, that's still unsatisfied.

**The reported "wasn't able to read logs properly, had to instruct it to keep going" turned out to be a missing retry, not a logs problem.** `agentMaxIterations` (10) already leaves plenty of room to retry a failed tool call within one reply, but nothing ever told the model to actually use that room - it would see an error, narrate "I'll check again" as if that were a complete answer, and stop, leaving the user to manually nudge it forward turn after turn.

Two-part fix, same "prompt guidance + deterministic backstop" pattern used throughout this project:
- `system-prompt.ts` gained a standing instruction: diagnose a tool error and retry with the minimal fix, in the same reply, instead of deferring to "later."
- `index.ts` gained a new deterministic retry loop - unlike every other check here (all one-shot), this one loops up to `MAX_TOOL_ERROR_RETRIES` (3) times, feeding back the *actual* error text each attempt via the existing trace mechanism (`onTrace`'s `tool_result` events already carried `isError`/`result`, just nothing read them for this purpose before). New `reason: "tool_error"` added to the retry trace union.

**Verified live**: asked for an update on a deliberately nonexistent task context id. Logs showed multiple real attempts with different parameters each time (the model actually trying to diagnose and adjust, not repeating the identical failing call) before correctly falling back to the deterministic honest-failure message once the id genuinely didn't exist - the intended behavior: retry when there's something to fix, admit failure honestly when there isn't, never confabulate success either way.

(Also fixed a stale pre-existing test in `classify-tools.test.ts` that never got updated when `project_propose` was added to the `self-growth` group in the prior coding-projects feature.)

### 2026-09-24 — `status_overview`: a real "what's going on" tool, plus another safety-net false positive it exposed

Two more real traces from live dogfooding: asked broadly about progress
across several concurrent interests (car, Linux, Python), the model
guessed one specific topic for `research_task_status` and answered
narrowly. Asked about coding tasks, it had `code_task`/`code_task_status`
bound (both scoped to checking one thing) but no way to *list* anything,
so it fell back to `task_context_manage(action='list')` - a completely
different concept (generic personal reminders, unrelated to coding or
research) - and presented mostly-`abandoned` leftover test entries as the
answer.

Root cause in both: **no chat-accessible tool ever answered "what's in
progress across everything,"** even though every piece of underlying data
already had a list endpoint built for the `/amy` web dashboard earlier
this session (knowledge-engine's `GET /projects`/`GET /research-queue`,
coding-orchestrator's `GET /tasks`). New skills-mcp tool `status_overview`
fetches all three in parallel and returns one consolidated summary - no
new backend work, purely wiring already-built endpoints into chat. Bound
to `goals`/`research`/`self-growth` (same multi-group membership
`project_propose` already uses). `research_task_status`/`code_task_status`
descriptions gained a one-line disambiguation ("one specific topic/this
conversation's task - for a broad question, use status_overview instead").

Small related fix, same trace: `task_context_manage`'s `list` with no
`status` returned *every* task_context ever created, which is how the
abandoned test debris surfaced. Defaults to `status='open'` now; the model
can still ask for the full history explicitly.

**A second, more interesting bug surfaced while verifying live**: a real,
successful `task_context_manage(list)` call - correctly answering "list my
open tasks" - still got overridden with the hardcoded
`REQUIRED_TOOL_FAILURE_MESSAGE`. Cause: the message classified into
`'goals'` (binding `goal_manage`/`status_overview`), and
`hasUnsatisfiedRequiredTool` only ever excused `task_context_manage` when
it was the *only* bound tool - with real `'goals'` capability tools also
bound, it kept checking "was `goal_manage`/`status_overview` called" and
ignored that `task_context_manage` had validly answered the same kind of
question instead. `task_context_manage` and `goal_manage` genuinely
overlap ("things to do") - this wasn't a wrong tool choice. Fixed by
passing `relevantGroups` through and treating `task_context_manage` as
satisfying the requirement whenever `'goals'` is among the classified
groups, regardless of which other `'goals'` tools were bound. Verified
live: the exact failing message now returns the real task instead of the
fallback.

### 2026-09-24 — `status_overview`'s raw blob, and a real cross-table id collision

Direct follow-up to `status_overview`'s launch, from a real dogfooding
session that got progressively less reliable turn by turn.

**The "blob" complaint**: `status_overview` returned nested objects
(`{id, title, status, activityType, progress}` per item), and the model
just enumerated those fields as bullets instead of writing prose - the
same "wall of raw data" failure `research_task_status` already hit once,
and the standing `responseStyleLine` prompt guidance alone didn't stop it
recurring for a new tool. Fixed the same way that one was: don't trust
the model to reformat raw data well, give it less to mangle. The tool now
builds an already-organized, grouped plain-text summary server-side
(deterministic string formatting, not an LLM call) - the model's job
becomes relaying/condensing already-readable text, not manually flattening
a JSON tree.

**The more interesting bug, found by reading the actual session transcript
back**: partway through, the model said *"the goal 'Learning Linux and
Bash Commands' (ID 8) is currently marked as abandoned"* - directly
contradicting what it had shown two replies earlier (an *active* project,
not a goal). Real root cause: goals, projects, task_contexts, and
coding_tasks are four **independent** tables, each with their own
numeric id sequence - project #8 and an earlier, since-abandoned goal #8
("Track job search") are two completely unrelated rows that happen to
share a number. Nothing anywhere labeled which table an id belonged to,
so a noisy `memory_recall` snippet mentioning "ID 8" in one context got
applied to the wrong entity in another - not a wrong tool choice, a real
ambiguity the model had no way to resolve.

Fixed by namespacing every id everywhere one gets shown to the model:
`goal_manage`, `task_context_manage`, and `status_overview` all now
return (or already returned, for `project_propose`) a `ref` field like
`"goal #8"` / `"task #8"` / `"project #8"` alongside the bare numeric
`id` (kept for follow-up tool calls, e.g. `goalId`/`taskContextId`
params still take a plain number). Both tools' descriptions gained an
explicit line naming this ambiguity and telling the model to always use
the prefixed form in conversation.

**Verified live**: "list my open tasks and projects" now shows
"Project #8", "Task #35", "Research #5" throughout, grouped by status
with duplicates collapsed into ranges (`Project #7, 6, 5`) instead of a
flat unlabeled dump; "list my active goals" shows "Goal #18" etc.
consistently. The specific cross-table confusion from the original
session can no longer happen the same way, since "8" is never displayed
without saying which table it's from.
