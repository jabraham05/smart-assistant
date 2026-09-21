# `Chat` workflow (n8n) — the main chat pipeline

Part of the [Smart Assistant](../README.md) project. See
[`docs/architecture.md`](architecture.md) for the project-wide service
overview this workflow sits inside of.

```
Chat client (n8n test chat / scripts/chat.mjs / chat-ui / discord-bot / future Pi)
        |
        v
n8n Chat Trigger (webhook, streaming response)
        |
        v
Get Persona (Data Table "personas", row "Amy") -> system prompt
        |
        v
Ensure Session Exists (Honcho: get-or-create session, idempotent)
        |
        v
Set User Observe Config (Honcho: user.observe_others=true, this session)
        |
        v
Get User Card (Honcho: user's own peer card)
        |
        v
Get User Card For Amy (Honcho: user's directional card, target=amy)
        |
        v
Get Active Skills (Data Table "skills", status=active, kind=instruction)
        |
        v
Format Skills Catalog (Code: joins active skills' full instructions)
        |
        v
AI Agent  ---- Ollama Chat Model (local LLM, GPU-accelerated)
   |     \---- Postgres Chat Memory (short-term: last N turns of this session)
   |     \---- MCP Client Tool -> skills-mcp (memory_recall, weather_get,
   |            skill_propose, calendar_event)
   v
Detect Garbage Output (Code) -> If Garbage Detected
   |no                              |yes
   v                                v
   |                    Fetch Recent History (Postgres)
   |                                |
   |                    Rebuild Fallback Prompt (Code)
   |                                |
   |                    Ollama Direct Fallback (raw /api/chat, no tools)
   |                                |
   |                    Normalize Fallback Output (Code)
   |                          /            \
   v                         v              v
HTTP Request -> Honcho /messages    Fix Postgres Memory Row
(stores the exchange, every turn; peer_id "amy")
```

## Known gotchas (learned the hard way)

- **Chat Trigger has two modes**: "Hosted Chat" (n8n's own widget, has its
  own session handling) and "Webhook" (for external clients — CLI, custom
  UIs, curl). Using "Hosted Chat" with a custom client silently collapses
  every session into one shared memory bucket, since it doesn't read a
  client-supplied `sessionId` the way Webhook mode does. Always use
  **Webhook** mode for anything other than n8n's own chat widget.
- **Response Mode matters for anything chained after the AI Agent node.**
  Default is `lastNode` (the last-executed node's output becomes the HTTP
  response) — so if a side-effect node (like our Honcho storage
  `HTTP Request`) runs after the Agent, the client gets that node's raw
  output instead of the reply. Set Response Mode to **`streaming`** so the
  Agent streams its reply directly regardless of what's chained after it.
- **`llama3.1:8b`'s native tool-calling is unreliable with n8n's AI Agent
  v3 — mitigated with a safety net, not fixed at the source.** Symptoms
  ranged from narrating failed tool calls ("It seems I made a mistake.
  Let me try that again.") to outright replying with literal `{}` garbage
  to plain greetings (~25–50% of the time in one test batch), sometimes
  followed by the model explaining "as instructed" that `{}` means no
  function call was needed — language that isn't in the persona prompt,
  meaning it's boilerplate from n8n's tool-binding scaffolding leaking into
  the visible reply instead of being parsed/discarded internally.
  Root-caused by testing with tools bound vs. fully removed: 0/18 failures
  with tools disconnected vs. multiple failures per batch with them
  connected — confirms the trigger is native tool-binding-to-Ollama itself,
  independent of which tool.
  - **Mitigation now in place** (see the pipeline diagram above): a
    `Detect Garbage Output` → `If Garbage Detected` chain runs after the AI
    Agent. On detection, a parallel path re-answers via a direct, tool-free
    call straight to Ollama's own `/api/chat` (bypassing the AI
    Agent/native-tool-calling scaffolding entirely — the one path proven
    reliable in testing), then corrects both Honcho's stored message and
    the short-term Postgres memory row so the garbage doesn't compound into
    later turns. Verified: re-running the same "hey amy hows it going" test
    that used to fail ~25–50% of the time now shows the garbage-correction
    path firing correctly and both memory stores ending up clean.
  - **The detection patterns needed a second round after a new failure
    shape slipped through**: the model can also narrate a fake tool call as
    prose (e.g. "...if I were to provide a JSON response for a function
    call: `{"name": "MCP_Client_Tool_get_weather", "parameters": {}}`" — the
    tool was still named `get_weather` at the time this was reproduced,
    before the 2026-07-27 rename to `weather_get`)
    *without* the AI Agent's own tracing showing any tool call actually
    happened (`tool_calls.completed: 0`) — meaning the model hallucinated
    what a call would look like instead of making one. This didn't start
    with `{}` and didn't say "no function call", so it slipped past the
    original patterns. `Detect Garbage Output`'s regex now also catches:
    any mention of "function call" at all, a literal internal tool/node
    name leaking into the reply (`MCP_Client_Tool`, `memory_recall(`,
    `weather_get(`), and a JSON blob shaped like `{"name": ..., "parameters"/"arguments": ...}`
    anywhere in the text. Verified against 8 known-good/known-bad cases
    plus live reproduction of all three failure shapes (`{}`-only, `{}` +
    trailing narration, and the new prose-only tool-call hallucination) —
    all three now get caught and corrected. Treat this as an evolving list,
    not a final one — new phrasings can still slip through.
  - **Third round: a real crash in the fallback itself, plus one more
    narration pattern.** Some historical Postgres Chat Memory rows have
    `content` as a non-string — an empty array `[]` (from a degenerate AI
    Agent turn with no real text) or, separately, a stringified tool-error
    JSON blob stored as if it were the assistant's actual reply (itself a
    likely contributor to earlier tool-failure-narration symptoms, since
    that noise then sits in future turns' visible history). `Rebuild
    Fallback Prompt` fed this straight into Ollama's `/api/chat` without
    normalizing types, and Ollama's Go server rejected it outright: `json:
    cannot unmarshal array into Go struct field ChatRequest.messages.content
    of type string` — a hard failure in the safety net's own fallback path,
    not the original model. Fixed by normalizing every history row's
    `content` to a string (joining array-of-parts shapes, coercing
    everything else) and dropping empty-after-normalization turns before
    building the fallback prompt. Also added a `Detect Garbage Output`
    pattern for narrating a failed tool call in prose (e.g. "It seems the
    tool call failed. I'll proceed with what I already know.") — a direct
    violation of the persona's "never mention tool failures" rule that
    wasn't literal `{}`/JSON and had slipped through. Regression-tested
    offline, then reproduced live (7/15 garbage hits in one batch, all
    `{}`-shaped, zero crashes, all corrected in memory) before re-exporting.
  - **Known remaining limitation, accepted for now**: because the Chat
    Trigger's Response Mode is `streaming`, the AI Agent's tokens (garbage
    included) go out to the user **live, as generated** — before the
    detection node even runs. So an occasional `{}` can still flash on
    screen for that one turn; the safety net stops it from being
    *remembered*, not from ever being *seen*. Fully preventing the flash
    would mean switching the Agent to buffer-then-respond instead of live
    token streaming — a bigger, separate change with its own UX cost (loses
    the "typing" feel), not done here.
  - **Fourth round: a raw MCP protocol error leaking into the reply, plus
    the fallback silently going stale when the model changed.** The model
    can call `memory_recall` with an empty/missing query (still
    happens sometimes despite the tool's own schema, the tool description,
    and the persona prompt all saying not to) — the MCP server correctly
    rejects it, but the model then sometimes prints the raw rejection
    straight into the reply (`MCP error -32602: Input validation error:
    Invalid arguments for tool memory_recall: ...`) instead of
    recovering silently. Added `/MCP error|Invalid arguments for tool/i` to
    `Detect Garbage Output` — a clean, effectively zero-false-positive
    signal. Separately: switching the `Ollama Chat Model` node's model (see
    below) exposed that `Ollama Direct Fallback` had `llama3.1:8b` hardcoded
    — if the fallback had fired, it would've silently queried the wrong
    (possibly unloaded) model. Fixed by referencing the other node's
    configured value directly instead of a hardcoded string:
    `$node["Ollama Chat Model"].parameter["model"]`. Not yet fire-tested in
    a live execution (the new model is reliable enough that the fallback
    didn't trigger in the verification batch) — the node-name reference is
    confirmed correct, but the expression itself is unverified in practice.
  - **Model swap results (informal, from manual testing)**: switching the
    `Ollama Chat Model` node from `llama3.1:8b` to `qwen3:8b` produced a
    dramatic reliability improvement — 0/12 garbage in one verification
    batch (vs. the ~25–50% failure rates `llama3.1:8b` was producing), and
    `weather_get`/`memory_recall` tool calls succeeded cleanly. Take
    this as encouraging but informal, not a rigorous benchmark — no fixed
    prompt set, sample size, or scoring methodology, and other models
    (`qwen3:14b`, `qwen3:4b`, `llama3-groq-tool-use:8b`) are visibly also
    being pulled/tried as of this writing. This doesn't reduce the value of
    the safety net (it's model-agnostic insurance), but it may mean the
    underlying reliability problem is substantially avoidable by model
    choice alone.
  - **2026-07-27 — the real root cause, isolated by controlled testing,
    was tool *count*, not a client bug.** Adding `spotify_control`
    surfaced repeated empty-`AI Agent`-output failures on plain
    commands ("pause the music," "skip to the next song," "what's
    playing") — the model's reasoning correctly concluded the right
    call, then the generation ended before ever emitting it. First
    hypothesis: a bug in n8n's `@n8n/n8n-nodes-langchain.lmChatOllama`
    losing `tool_calls` whenever a response also carries a `thinking`
    field (independently reported elsewhere — n8n's own community
    forum, Home Assistant's Ollama integration hitting the identical
    `qwen3` symptom) — seemingly confirmed by a raw `curl` to Ollama
    directly returning a clean `tool_calls` array for the same message.
    **This hypothesis was then disproven** by a more controlled follow-
    up test: deploying `ollama-mcp-bridge` (a purpose-built Ollama↔MCP
    proxy) and calling it directly, bypassing n8n entirely, with the
    *real* 6-tool `skills-mcp` catalog auto-injected — same failure,
    0/3. The earlier "raw Ollama works" test had used a single
    simplified tool with a short description, not the real toolset —
    it never controlled for tool count, so it wasn't actually isolating
    the client as the variable. Re-running with the bridge limited to
    just `spotify_control` (`toolFilter` config) fixed it, 3/3. Re-
    running the *exact same reduction* through n8n's own native
    `MCP Client Tool`/`AI Agent` path (`includeTools: ["spotify_control"]`,
    bridge removed from the picture entirely) also fixed it, 3/3 — so
    there was never a separate n8n-specific bug at all: `qwen3:8b`'s
    tool-calling reliability through this exact integration collapses
    specifically as bound tool count grows, independent of client. This
    is the same "3-5 tools" ceiling
    [`docs/persona-system.md`](persona-system.md)'s tool-count guidance
    already flagged, now measured directly rather than assumed.
    `ollama-mcp-bridge` was removed after disproving the hypothesis it was
    deployed to test — it provided no benefit the native path doesn't
    already have once tool count is controlled.
  - **Fixed with dynamic, per-message tool-group filtering** (note: the
    category list below — `media`, `scheduling`, `info`, `self-growth` —
    is the original 4-category set from when this mechanism first
    shipped. It grew to 9 categories as more tools were added over time,
    then got consolidated to 5 during the 2026-09-20 Coordinator work
    documented near the end of this file — left as-written here for
    historical accuracy rather than silently rewritten) — the
    `Chat` workflow gained `Classify Relevant Tool Groups` (a raw
    Ollama `/api/chat` call with a JSON-Schema `format`, same
    structured-output pattern as `skill_gap_scanner`/the coding-agent
    pipeline — deliberately not native tool-calling, since that's the
    exact mechanism proven unreliable) → `Expand Groups To Tools` (a
    Code node mapping a small set of named categories — `media`,
    `scheduling`, `info`, `self-growth` — to their member tool names,
    the same coarse-"toolset" grouping pattern GitHub's own official MCP
    server uses to manage its 33 tools) → `MCP Client Tool`'s
    `includeTools` now reads `={{ $('Expand Groups To Tools').item.json.relevantTools }}`
    instead of exposing all 6 tools always. Confirmed via direct testing
    that `includeTools` (an array-type parameter) genuinely accepts a
    per-execution expression, not just a static design-time list — this
    is what makes per-message dynamic narrowing possible at all.
    Classification failure/timeout defaults to an empty list (no tools
    bound, safe conversational fallback) rather than "all tools," so a
    classifier hiccup can't reintroduce the exact failure mode this
    exists to avoid.
    **Verified end-to-end, one message per group plus edge cases, via
    real execution data (not just reply text)**: `media` → `pause the
    music` correctly narrowed to `spotify_control` alone and succeeded;
    `info` → a weather question correctly narrowed to
    `weather_get`+`memory_recall` and succeeded; `scheduling` → a
    calendar question correctly narrowed to `calendar_event` and
    succeeded (reported "not configured" gracefully, as expected);
    a **two-group** message ("what's the weather and can you pause my
    music") correctly classified both `info` and `media` at once and
    resolved both tools correctly in a single reply; a plain greeting
    classified zero groups, bound zero tools, and answered normally.
    0 empty-output failures across the batch, versus 0/6 successes on
    the same class of request before this fix.
    **Known maintenance cost, accepted deliberately**: the group→tool
    mapping lives only in the `Expand Groups To Tools` Code node,
    separate from `skills-mcp/src/server.ts`'s actual tool registration
    — adding a new tool later means also remembering to add it to a
    group, or it's silently never exposed through chat (no error
    either way). Also: every single chat turn now costs one extra
    sequential model call before the real response starts, including
    turns that never needed a tool at all — a real, accepted latency
    cost traded for reliability, worth revisiting if it turns out to
    matter in practice.
  - **`weather_get`'s geocoding needed a fallback strategy.** Open-Meteo's
    free geocoding endpoint does plain city-name matching and returns zero
    results for compound phrasing like "bothell washington" or "Bothell,
    WA" — it wants just "bothell". This caused a real discrepancy: the same
    query worked in n8n's own test chat (user typed just the city) and
    failed in `chat-ui` (user typed "city + state"), which looked like a
    client-specific bug but wasn't. Fixed in `skills-mcp/src/lib/open-meteo.ts`'s
    `geocode()`: try the full string, then a comma-split prefix ("City, ST"
    → "City"), then progressively drop trailing words ("City State" →
    "City") until one resolves — verified against "bothell washington",
    "Bothell, WA", and "los angeles california" (all previously failing,
    all now resolving to the correct city without breaking legitimate
    multi-word city names).
  - **New related quirk observed after adding `weather_get`**: the model
    has occasionally answered a plain greeting or an unrelated question
    (e.g. "what is your name?") by talking about weather instead — a softer
    version of the same "reaches for a tool it shouldn't" tendency, just
    landing as topical derailment rather than literal garbage, so it isn't
    caught by the `Detect Garbage Output` patterns. Left as a known/open
    item; likely needs tool-description or system-prompt tuning if it keeps
    happening.
  - Tools are now consumed via a `skills-mcp` MCP server (`memory_recall`,
    `weather_get`) rather than bespoke n8n HTTP Request Tool nodes — see
    [`docs/architecture.md`](architecture.md).
  - **2026-09-04 — a stream can end with genuinely zero `AI Agent` tokens
    for that turn, not just garbage ones.** The safety net above corrects
    Honcho/Postgres memory so a *future* turn stays clean, but it runs
    after the response has already streamed and closed — it has nothing to
    hand back for the turn currently in flight. `chat-ui` used to render
    this as a literally blank message bubble with no indication anything
    happened. Fixed client-side, not in n8n: `useChat.ts` tracks whether
    any `AI Agent` content actually streamed, and if none did, overwrites
    the bubble with a plain "No response was generated for that message —
    try asking again." (`ChatMessage.isEmpty`, styled distinctly in
    `MessageBubble.tsx`) — a UI-level mitigation for this same underlying
    gap, not a fix for it.
- **`alwaysOutputData` is needed on `Fetch Recent History` for the fallback
  chain to work on a brand-new session's very first turn.** If that turn's
  output is garbage/empty, `Postgres Chat Memory` never saves anything for
  it (nothing to save), so a fresh session has zero prior rows — and n8n
  does not execute a node's downstream connections at all when it receives
  zero input items (see [`docs/known-gotchas.md`](known-gotchas.md) for the
  general rule). Without `alwaysOutputData: true` on `Fetch Recent
  History`, the *entire* fallback chain (including the final Honcho-storage
  write) silently never ran for this specific case, losing the turn
  instead of correcting it. `Rebuild Fallback Prompt` is written
  defensively (`.filter(Boolean)` on the mapped `message` field) to handle
  the placeholder empty item this produces when there's truly no history.
- **The same zero-items-means-downstream-never-runs rule bit `Get Active
  Skills` too, and much harder — it took the whole Chat pipeline down.**
  Once every row in the `skills` Data Table had `status != 'active'` (after
  a backlog triage/cleanup left only `proposed` rows), `Get Active Skills`'
  filter matched nothing, so `Format Skills Catalog` and — critically — the
  `AI Agent` node itself never executed. Nothing errored (`status: success`
  in `execution_entity`); the webhook (streaming `responseMode`) just
  closed with a genuinely empty body, in both chat-ui and n8n's own chat
  UI. Confirmed by decoding `execution_data` with `flatted` and seeing
  `runData` stop dead at `Get Active Skills` with no error and no later
  nodes present. Fixed the same way as `Fetch Recent History`:
  `alwaysOutputData: true` on `Get Active Skills`, so it always emits at
  least one (possibly empty) item and the rest of the chain — including
  `AI Agent` — always runs. `Format Skills Catalog` already handled an
  empty skills array gracefully (`skills.length ? ... : ''`), so no changes
  needed there. Lesson: any Data Table `get`/query node feeding a chain
  that must never go silent (especially one upstream of the actual
  reply-generating node) needs `alwaysOutputData: true`, not just the ones
  already known to hit this — worth auditing other pipelines for the same
  class of node.

### 2026-09-20 — Coordinator: capability consolidation, cross-turn handoff, and persistent TaskContext

Reviewing the built-out `knowledge-engine` (deterministic router + hybrid
retrieval + research agent — see `docs/knowledge-engine.md`) against the
project's own architecture surfaced that this Chat workflow's flat,
9-category, fully-stateless-per-turn classifier was the missing layer
above it: a small named set of capabilities (an Agent Registry) with
deterministic routing, a way to hand off across turns when the topic
genuinely changes, and a way for something spanning multiple real-world
days to resume correctly later. Domain-specific agents (automotive/
warframe) were explicitly rejected in favor of `domain` metadata on the
existing shared Research capability — already fully satisfied by
`knowledge-engine`'s `documents.domain`/`research_sessions.domain`
columns, zero changes needed there.

**Capability consolidation (9 groups → 5).** `Classify Relevant Tool
Groups`'s enum shrank to `["research","personal","automation","self-growth"]`;
`General` (just `calculate`, later also `task_context_manage`) stays
implicit/always-on, not a classifier output. New `Expand Groups To
Tools` mapping:
```js
const GROUPS = {
  research: ['knowledge_search', 'knowledge_ingest', 'research_task', 'research_task_status', 'web_search'],
  personal: ['memory_recall', 'goal_manage'],
  automation: ['calendar_event', 'spotify_control', 'dashboard_control', 'weather_get'],
  'self-growth': ['skill_propose', 'code_task', 'code_task_status'],
};
```
`Detect Unfulfilled Search Intent` and `Detect Garbage Output` needed no
changes — both key on literal tool names, never group names, and no tool
name changed. Verified live, one message per capability plus a
two-tool-in-one-turn message, checked against real n8n execution data.

**`delegate()` needs no new infrastructure — confirmed, not built.** The
classifier can already return several groups in one pass ("zero, one, or
a few"), and `AI Agent`'s single tool-calling loop already gets every
selected group's tools simultaneously and can call several in sequence.
This already worked before this change and still does after.

**`handoff()`: cross-turn capability continuity.** The real gap:
classification only ever saw the current message in isolation, so an
ambiguous follow-up ("and what's normal for that?") could misclassify
even when the prior turn was obviously the same topic. Finished wiring
`event-bus`'s `events` table instead of building new infrastructure — it
already accepted `originSessionId`/`payload`, nothing populated them.
`Expand Groups To Tools` now also returns its already-computed
`relevantGroups`; a new `Publish Classification Event` node (positioned
*after* `Expand Groups To Tools` in the linear chain — not a change to
the existing `Publish Message Event`, which fires in parallel directly
off the trigger and can't reference that node's output) POSTs it to
`/events`. New `event-bus` endpoint `GET /sessions/:sessionId/last-capability`
reads the most recent non-empty-groups classification for a session
(skips zero-group turns deliberately, so a plain "thanks" doesn't erase
real continuity). A new `Get Last Active Capability` node calls this
*before* classification — inserted as a real predecessor of `Classify
Relevant Tool Groups` (trigger → `Get Last Active Capability` → `Classify`),
not a parallel sibling, so its data is guaranteed available — and its
result is injected into the classifier's prompt as one more fact, with
an instruction to keep an ambiguous follow-up under the same capability
but classify normally on an explicit topic change. This adds no second
LLM judgment call: the classifier already makes this call every turn,
this just gives it one more deterministic input; the write side is a
pure passthrough of already-computed data.

Verified live with a real 3-turn conversation, decoded from n8n's
`flatted`-encoded execution data (not text-matched, which proved
unreliable — see below): "fuel sender resistance range" → `research`; "and
what's normal for that?" (no topic keywords) → stayed `research`, confirmed
`Get Last Active Capability` genuinely returned `["research"]` for that
exact execution; "actually, pause the music" → switched to `automation`
only, confirming an explicit new topic overrides continuity correctly.

**Persistent cross-session `TaskContext`.** For something that spans
multiple real-world days and needs to resume later (e.g. "measure the
fuel sender now, full reading tomorrow"). New `task_contexts`/
`task_context_log` tables in the `events` database (owned by `event-bus`,
alongside `goals`/`scanner_state` — the existing precedent for
cross-cutting, not-owned-by-one-capability concepts), with a `status`
that includes `waiting_for_user` — the state none of `goals`/
`coding_tasks`/`research_sessions` has today.

Investigated whether session id or user identity is the right
reconnection key: `chat-ui` mints a fresh random session id on every page
load (`useSessions.ts`, not persisted client-side), so a session-keyed
lookup would fail on the realistic "resume tomorrow in a new tab" case.
Honcho's peer card is workspace-level, not session-scoped, confirming
there's exactly one real human user across every client — so
reconnection is a flat "any open task?" status query (`GET
/task-contexts?status=open`), not a session or semantic match. A new
always-on `task_context_manage` MCP tool (mirrors `goal-manage.ts`'s
shape) is homed in `General` alongside `calculate` rather than gated by
classification, since a task can span capabilities. A new `Get Open Task
Contexts` node injects open tasks into `AI Agent`'s system prompt the
same way `Get User Card`'s peer card already is.

**A real wiring bug, caught during verification, not assumed away.**
`Get Open Task Contexts` was first wired as a pure parallel branch off
the trigger, apparently matching `Get Persona`/`Get User Card`'s
pattern — but those aren't actually parallel-off-trigger at all; they're
chained sequentially into `AI Agent`'s real input path (`Expand Groups To
Tools → Get Persona → ... → Format Skills Catalog → AI Agent`), which is
what actually guarantees they've executed by the time `AI Agent`'s
`systemMessage` expression evaluates. A true trigger-parallel sibling has
no such guarantee. This surfaced as real, reproducible failures: `AI
Agent` output `{"error":"Node 'Get Open Task Contexts' hasn't been
executed"}`, decoded via `flatted` from the raw execution data (grepping
the raw text was insufficient here — the same lesson `docs/
coding-agent-pipeline.md` already documents for `flatted`-encoded
`execution_data`). Fixed by inserting the node into the real chain
(`Format Skills Catalog → Get Open Task Contexts → AI Agent`) instead.

**Verified live, with two real, honestly-reported limitations found along
the way, neither caused by this change:** task creation and the first
log entry (`empty tank read 240 ohms`) both worked with real tool calls
and real DB changes. Verifying the cross-session reconnection step
itself repeatedly hit `qwen3:14b` running at only 16% GPU/84% CPU — even
immediately after a full `ollama` container restart, confirming this is
a chronic VRAM constraint at the model's configured 16384-token context
window, not transient fragmentation from testing. Independently confirmed
unrelated to this feature: the same empty-output failure reproduced with
zero open tasks injected at all. Separately, one attempt that did get a
real model response claimed a completed action ("I've logged the
measurement") without actually calling `task_context_manage` — the same
confabulation class already fixed for `research_task` (see `docs/
knowledge-engine.md`). Checked whether `Detect Garbage Output`'s existing
safety net could be extended to catch this: its verb-claim regex doesn't
include "logged/tracked/recorded," and `task_context_manage` can't be
usefully added to its `ACTION_TOOLS` list since it's unconditionally
bound every turn (like `calculate`) — adding it would make that check's
`hadActionTool` always true, silently disabling the check for every other
action tool too. Documented as a known limitation rather than patched
speculatively; the deterministic mechanism (schema, API, injection) is
proven correct independent of these two LLM-reliability gaps.

### 2026-09-20 — model swap to fix CPU-bound inference; a persona fix that didn't move the needle; a new tool-count mystery

Running the two test conversations above through `chat-ui`'s real endpoint (not just `scripts/chat.mjs`) surfaced two suspected causes for the reconnection failure, both investigated and root-caused with real evidence rather than guessed at.

**GPU/CPU: fixed, confirmed.** `qwen3:14b` (the `AI Agent` node's model) was running at 16% GPU / 84% CPU — confirmed via live `nvidia-smi` inside the `ollama` container, even immediately after a full `ollama` restart (ruling out transient fragmentation). Root cause: the GPU is a single 12GB RTX 5070, and `ollama ps` reports `qwen3:14b` alone at 12GB resident — the *entire* card, before any KV cache for its 16384-token context and before the always-resident `qwen3:8b` classifier or warmup model (`OLLAMA_KEEP_ALIVE=-1` keeps everything loaded forever) factor in at all. No context-window tuning fixes a model whose own weights already equal 100% of available VRAM. Switched `Ollama Chat Model` to `qwen3:8b`, matching the classifier's model - `ollama ps` now shows `qwen3:8b` at 100% GPU (7.5GB resident), and a real turn dropped from ~50-60s to ~6s.

**A new, real bug this switch exposed**: with the slowness gone, the `research` capability's tool binding (7 tools — 5 group tools plus the always-on `calculate`/`task_context_manage`) produces a consistent empty-output failure - the model generates real completion tokens (confirmed via Ollama's own `tokenUsage`, e.g. `completionTokens: 40`) that never resolve into visible text or a parsed tool call (`tool_calls.requested: 0`). Tested the obvious fix - dropping `research_task_status` to bring the count to 6, matching `automation`'s working 6-tool set - and it did **not** fix it (3/3 failures at the identical tool count that succeeds for `automation`). This rules out raw tool count as the sole variable; the actual cause is likely total tool-description bulk or a specific interaction between `research`'s search-shaped tools (`knowledge_search`/`web_search`/`research_task` all sound similar), not measured further here. Reverted the tool-count change since it cost real functionality (making `research_task_status` unreachable) without fixing anything. **Left as a known, separately-scoped issue** - a proper investigation would need the same rigorous approach this project used for the earlier MCP-tool-name-prefix bug (a reverse-proxy byte capture between n8n and Ollama), not further guessing.

**Persona fix: landed correctly, but did not measurably fix the actual behavior.** Found a real, specific gap while investigating the earlier `task_context_manage` confabulation: the persona's "before using any tool, check if you already have the answer" disposition paragraph named four context sources that justify *skipping* a tool call (persona, user card, standing instructions, skills) and was never updated when Open Task Contexts was added - so the model had no instruction that recognizing an open task means it should *act*, not just answer conversationally. Fixed the disposition paragraph, reordered "How to respond" so tool-use-critical bullets come before tone/reflex-script bullets, consolidated three separate reflex-script bullets into one, and tightened the Address section - all applied via direct SQL to the `personas` Data Table, verified byte-for-byte against the intended text (5937 characters, down from 6799). Tone/character verified unchanged on a real turn.

**Honest result**: re-ran the cross-session reconnection scenario multiple times after the fix. Every single attempt still failed to produce a real, verified `task_context_manage` call - one gave a generic non-task answer, one said "I don't have anything on that," and one **confabulated a false "I've noted it" claim** (caught only by checking the database directly, not the reply text - the `task_context_log` table showed no new row). Across this entire session's testing, both before and after the persona fix, the cross-session reconnection scenario has never once produced a genuine, database-verified tool call. The disposition-paragraph fix is a real, correct improvement to the prompt (closes an actual instruction gap, not imagined), but on the evidence gathered it has not moved the observed success rate - this appears to be a deeper model instruction-following limitation than a single prompt fix closes, in the same family as the `research` tool-count mystery above. Also independently observed during this same testing: a `goal_manage` call with a hallucinated `goalId` (12345) got a real 404, and the model narrated the failure ("It seems there's a hiccup with the system") - a direct violation of the persona's own "never mention tool failures" rule that `Detect Garbage Output`'s existing patterns don't catch (`garbage: false` for that exact output) - a second, pre-existing, independent gap, not caused by this session's changes.

**What this session's evidence actually supports going into next steps**: the GPU fix is real and should stay. The persona fix is a correct, worthwhile prompt-hygiene improvement and should stay, but should not be treated as having solved the reconnection reliability problem - that remains open. Both the `research` tool-count mystery and the `task_context_manage`/`goal_manage` confabulation pattern look like the same underlying class of problem (qwen3, via n8n's native tool-calling integration, has a real and not-yet-fully-characterized reliability ceiling that neither model swaps nor prompt wording alone have closed in this session's testing) - worth a dedicated, rigorous investigation rather than another round of point fixes, the next time this area gets picked up.

### 2026-09-20 (continued) — root-caused the `research` empty-output bug with a real byte capture; caught live in production first

This bug stopped being hypothetical the same day it was found: a real Discord message ("What did you learn about my car") got answered as if the knowledge base were empty, and a follow-up ("did you not find the manual for the car") got a confident "I did not find the manual for your car" - both confabulations. Traced the second one to a real execution: classified `research` (7 tools bound), `tool_calls.requested: 0`, `tool_calls.completed: 0` - `knowledge_search` was never called at all, despite the Cayman manual genuinely being in the knowledge base.

Root-caused with the same technique this project used for the earlier MCP-tool-name-prefix bug: stood up a disposable logging reverse-proxy between n8n and Ollama (a temporary credential pointing `Ollama Chat Model` at the proxy instead of `ollama:11434` directly, reverted afterward), and captured the exact request/response bytes for a real failing call versus a real succeeding one (`what's the weather in Chicago`, `automation` capability).

**The raw evidence is conclusive.** The working call gets Ollama's normal two-chunk tool-call response: one chunk with `"tool_calls":[{...weather_get...}]` and `"done":false`, then a final `"done":true` stats-only chunk (`eval_count: 24` for the tool-call chunk). The failing call gets exactly **one** chunk: `{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","eval_count":33,...}` - no `tool_calls` field at all, despite spending *more* generation tokens (33) than the working call needed to successfully emit a real tool call (24). The model generated something for this specific 7-tool combination that Ollama's constrained tool-calling decoder couldn't parse into either free text or a structured call, and silently dropped it - with zero error anywhere in the stack (`execution.succeeded: true`), the exact "fails with zero error signal" pattern already documented for the MCP-tool-name-prefix bug in `docs/coding-agent-pipeline.md`.

This rules out every theory tested so far as the *sole* cause (tool count, total description length, single-tool segment count all failed to distinguish the working case from the failing one when checked against real data) and confirms it's a genuine model/inference-stack-level tool-calling grammar failure, not an n8n, schema, or prompt-wording problem - not something fixable by further point tweaks on the n8n side alone.

**Mitigation added, one part verified working, one part not.** Extended the existing `Detect Unfulfilled Search Intent` → `Should Retry Search?` loop (previously only triggered by a narrow regex match on reply text like "let me try again") to also trigger on genuinely empty `AI Agent` output whenever a real capability tool was bound - reusing the proven retry-loop wiring rather than building a second one. Also updated the `AI Agent` retry-nudge text to cover "produced nothing at all," not just "said it would retry and didn't," and added an explicit instruction to `Rebuild Fallback Prompt`'s system message telling the model it has zero tools in that path and must never claim to have searched/checked/logged something it didn't.

**Retry loop: verified working.** Re-ran the exact failing query 4 times; every single time `AI Agent` ran twice (`shouldRetrySearch: [true, false]`), confirming the broadened detection correctly fires on empty output and the loop-back correctly re-invokes the agent once before falling through. No regression on `automation`/plain-greeting controls (`AI Agent runs: 1` for both, confirming the broadened check doesn't retry successful turns unnecessarily).

**Fallback confabulation fix: did not work, reported honestly rather than claimed as fixed.** All 4 retries still failed on the second `AI Agent` pass too (the underlying Ollama grammar bug isn't fixed by a retry, it just gets one more roll of the dice), so all 4 fell through to the tool-free fallback - and the fallback still confidently fabricated specific, wrong technical detail ("DOT 4 or DOT 5.1 specification" - the real manual only says "Original Porsche brake fluid," no spec number at all) despite the new explicit instruction *and* the persona's own pre-existing "never invent specific facts" rule. This is a plausible-sounding automotive fact from the model's general training data, not a claim of having used a tool, so the new wording (targeted at tool-use claims specifically) didn't cover it - and the persona's broader, pre-existing anti-fabrication rule doesn't reliably stop it either. Left as a further-confirmed instance of the same underlying reliability ceiling, not patched further here.

### 2026-09-20 (continued) — the "conclusive" byte-capture root cause didn't survive replication; model benchmarking instead

Attempted to build on the byte-capture finding above by reproducing the exact failing request in isolation (same model, same 7 real tools, same real 6215-character system message, same failing prompt), expecting a deterministic repro to design a targeted fix against. **It did not reproduce at all.** `stream:false` succeeded 6/6; retrying with `stream:true` (matching n8n's actual behavior, which the first pass omitted) succeeded 5/5, including a rep with `eval_count: 33` - the exact eval count the original failing capture had, yet this one succeeded; adding the real system message back in (the first pass tested with none) succeeded 5/5; simulating real concurrent load by firing a classifier-shaped call from a background thread ~50ms before the agent-shaped call, mimicking n8n's actual Classify→AI Agent sequencing, succeeded 5/5; a larger N=20 sample with every real condition matched produced **0/20 failures**.

This is a genuine correction, not a refinement: the earlier "conclusive... genuine model/inference-stack-level tool-calling grammar failure" framing overreached. A single-chunk, no-`tool_calls`, `eval_count: 33` response is real (both this investigation and the original capture saw it), but it is not deterministically tied to this tool combination - it reproduced 0 times across every real condition tried in isolation. The true trigger is still unidentified; the leading hypothesis is now a rare, possibly GPU-contention- or environment-specific event from other real concurrent load on the shared `ollama` instance (n8n's Chat workflow, `knowledge-engine`'s research agent, and `coding-orchestrator` all point `OLLAMA_HOST` at the same container), or a genuinely low but nonzero baseline failure rate too rare for a 3-6 rep sample to characterize - not a static, always-reproducible defect fixable by a model swap alone. The retry-loop mitigation above should still help in production regardless of the exact trigger (it catches the empty-output symptom whatever causes it), but this is worth flagging plainly: nothing below proves any model is immune to whatever actually causes the live failure, only that it wasn't caught in these isolated tests.

**Model comparison, done anyway because reliability data is still useful on its own terms.** Researched two new candidates sized for the 12GB RTX 5070 (`hermes3:8b`, 4.7GB; `granite3.1-dense:8b`, 5.0GB) - both sourced from Ollama's library, not guessed - and ruled out two others before downloading anything: Firefunction-v2 only ships at 40GB (no sub-10B variant), and Gemma3 native tool-calling is documented as weak below ~12B (community "gemma3-tools" patches exist specifically because of this). Benchmarked all 6 candidates two ways: the project's existing `scripts/benchmark-models.mjs` (generic 4-tool synthetic test, 3 reps) and a new `benchmark-amy-scenario.mjs` replaying the exact real 7-tool `research` schema and the real failing prompt (`what does my knowledge base say about brake fluid for the Cayman`) directly against Ollama, at N=20 given the statistical-power gap a smaller sample left in earlier passes.

| Model | Generic tool-call % | Generic accuracy % | Real-scenario success % (N=20) |
|---|---|---|---|
| `qwen3:8b` (current) | 100 | 71.4 | 100 |
| `llama3.1:8b` | 83.3 | 57.1 | 100 |
| `llama3-groq-tool-use:8b` | 83.3 | 71.4 | 10 |
| `qwen3:4b` | 33.3 | 85.7 | 100 |
| `hermes3:8b` | 83.3 | 57.1 | 100 |
| `granite3.1-dense:8b` | 16.7 | 57.1 | 0 |

Two results specifically contradict name/reputation-based guessing: `llama3-groq-tool-use:8b` - a fine-tune literally named for tool use, and the earlier top pick before any data existed - collapsed to 10% on the real scenario (it answers from training data instead of calling `knowledge_search` almost every time); `granite3.1-dense:8b` never once called a tool on the real scenario across 20 reps, always confabulating an answer instead. `hermes3:8b` is a legitimate, competitive alternative (100% on the real scenario, similar latency to `qwen3:8b`), but doesn't beat the current model on any measured axis. **Initial decision: keep `qwen3:8b`.** It was the only model at 100% on both benchmarks at the time - reversed a few hours later, see below.

### 2026-09-20 (continued) — actually found it: every benchmark above tested the wrong tool names

The "keep `qwen3:8b`, real trigger still unknown" conclusion above didn't survive one more question: why do these benchmarks all show 100% when production doesn't? Answer: every benchmark run today - the project's `scripts/benchmark-models.mjs`, the custom Amy-scenario script, all of it - tested against bare tool names (`knowledge_search`). n8n's `MCP Client Tool` node never sends bare names. Traced the actual source (`McpClientTool/utils.js` inside the n8n image): `buildMcpToolName(node.name, toolName)` sanitizes the node's own display name and prepends it - `serverName.replace(/[^a-zA-Z0-9]/g, '_') + '_' + toolName`, capped at 64 chars total. The live `Chat` workflow's node is literally named `MCP Client Tool`, so every tool Ollama actually sees is prefixed `MCP_Client_Tool_` - e.g. `MCP_Client_Tool_knowledge_search`. Nobody had tested that string.

Rebuilt the real tool schema with the real prefix and reran: `qwen3:8b` fails **20/20**, every single rep landing on `eval_count: 33` - the exact number from the original byte capture, now fully explained and 100% reproducible instead of a mystery. Bisected the prefix length to rule out "any prefix breaks it": `MCP_` and `MCP_Client_` both pass 10/10 on `qwen3:8b`; only the full `MCP_Client_Tool_` (16 chars) fails. `hermes3:8b` also fails 20/20 with the real prefix, despite passing the earlier (wrong) bare-name test. `llama3.1:8b` and `qwen3:4b` both pass 20/20 with the real prefix.

Considered just renaming the node to shorten the prefix (cheap, and the bisection shows it would work today) but rejected it as the primary fix - it treats the symptom of an undocumented length threshold on a model already shown to have a real grammar/decoder fragility, not the underlying model limitation. A future tool, a longer description, or someone renaming the node back would reopen the same class of bug with no warning. Stress-tested instead: built a deliberately worse-than-real schema (8 tools, one name 66 chars long, beyond even n8n's own 64-char cap - purely to test the model's raw margin). `qwen3:8b` still fails 10/10. `llama3.1:8b` and `qwen3:4b` both still pass 10/10 - real headroom, not a lucky pass on today's exact string.

**Fixed the benchmark methodology itself, not just the model.** The reason this slipped through in the first place is every benchmark's tool list was hand-typed once and never re-checked against reality. Added `scripts/verify-tool-schema-compat.mjs` - it connects to skills-mcp's real MCP endpoint with the actual `@modelcontextprotocol/sdk` client (the same one n8n's node uses), pulls the live `tools/list`, reads the real node name out of the checked-in workflow export, and applies the exact ported `buildMcpToolName` algorithm - so the tool schema it tests against can never silently drift from what n8n actually sends again. Run inside a container on `assistant-net` (skills-mcp has no published port): `docker compose exec -T n8n node verify-tool-schema-compat.mjs --model=llama3.1:8b --reps=20 --workflow=/tmp/workflow.json`. Validated `llama3.1:8b` against the real, live skills-mcp catalog (not a static file) at 20/20 on the exact `research`-capability tool subset.

**Decision reversed: switched to `llama3.1:8b`.** Changed both places the model is configured - the `Ollama Chat Model` node feeding `AI Agent`, and the separate `Classify Relevant Tool Groups` node, which hardcodes its own model string in a raw HTTP call and is easy to miss (confirmed by grep before touching anything - only these two references exist). Both had to move together: leaving them mismatched would reopen the exact within-turn VRAM-doubling problem the `qwen3:14b`→`qwen3:8b` swap fixed earlier this same day. Applied through the n8n UI (edit + save publishes immediately, no CLI import/restart cycle needed) rather than the DB/CLI path, per this project's own standing preference when UI access is available.

**Verified live, not just in isolation.** `ollama ps` after a real turn shows only `llama3.1:8b` resident (100% GPU, 7.0GB) - no `qwen3:8b` left loaded, confirming the two config points actually stayed in sync. Sent the exact real failing query (`what does my knowledge base say about brake fluid for the Cayman`) through the live production webhook and decoded the resulting execution's `flatted` data directly from Postgres: `MCP Client Tool`'s run shows a genuine `knowledge_search` call that returned real content from the actual Cayman owner's manual (page 273: "Brake fluid... use only Original Porsche brake fluid"), and `AI Agent`'s final reply quotes that real fact with no fabricated spec number - unlike the earlier fallback path's confabulated "DOT 4 or DOT 5.1." The bug that started with a real Discord message is fixed in the live system, confirmed against the database, not just a plausible-looking reply.
