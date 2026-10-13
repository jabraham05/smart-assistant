# `Chat` workflow (n8n) — the main chat pipeline

Part of the [Smart Assistant](../README.md) project. See
[`docs/architecture.md`](architecture.md) for the project-wide service
overview this workflow sits inside of.

**Diagram re-drawn 2026-10-13** directly from the current export's
`connections` object (`n8n/workflows/9YdYYhVGfsKgj4yz.json`,
`updatedAt: 2026-09-21T08:45:56.270Z`, 29 nodes) — the previous version of
this diagram predated the **2026-09-20** entry below and didn't show the
tool-group classifier, the search-retry loop, or the event-bus wiring at
all.

```
Chat client (n8n test chat / scripts/chat.mjs / chat-ui / discord-bot / future Pi)
        |
        v
n8n Chat Trigger (webhook, streaming response)
        |
        +-------------------------------+
        v                               v
Publish Message Event           Get Last Active Capability
(event-bus, fire-and-forget,    (event-bus: which tool group, if any,
 no downstream connection)       answered this session's prior turn)
                                        |
                                        v
                        Classify Relevant Tool Groups (raw Ollama /api/chat,
                           structured output: research/personal/automation/
                           self-growth - sees the prior capability above so
                           an ambiguous follow-up stays in the same group)
                                        |
                                        v
                        Expand Groups To Tools (Code: group -> member tool
                           names; calculate + task_context_manage always
                           included regardless of classification)
                              /                              \
                             v                                v
                  Publish Classification Event        Get Persona (Data Table
                  (event-bus, fire-and-forget)         "personas", row "Amy")
                                                              |
                                                              v
                                                Ensure Session Exists (Honcho)
                                                              |
                                                              v
                                              Set User Observe Config (Honcho)
                                                              |
                                                              v
                                                   Get User Card (Honcho)
                                                              |
                                                              v
                                            Get User Card For Amy (Honcho)
                                                              |
                                                              v
                                 Get Active Skills (Data Table "skills",
                                    status=active, kind=instruction)
                                                              |
                                                              v
                                 Format Skills Catalog (Code: joins active
                                    skills' full instructions)
                                                              |
                                                              v
                                 Get Open Task Contexts (event-bus: open
                                    TaskContext steps, status=open)
                                                              |
                                                              v
   +--------------------------------------------------------+
   v
AI Agent  ---- Ollama Chat Model (local LLM, GPU-accelerated)
   |     \---- Postgres Chat Memory (short-term: last N turns of this session)
   |     \---- MCP Client Tool -> skills-mcp, includeTools = Expand Groups
   |            To Tools' per-message dynamic tool list (not a fixed 4
   |            tools - see the 2026-09-20 entry below)
   v
Detect Unfulfilled Search Intent (Code) -> Should Retry Search?
   |no                                            |yes, loops back to AI Agent
   v                                               (via Prepare Search Retry Nudge)
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

## 2026-09-21 — replaced by `chat-orchestrator` for real traffic; kept published as the rollback

`chat-ui` and `discord-bot` no longer call this workflow — both were
repointed at a new self-hosted service, `chat-orchestrator` (see
[`docs/chat-orchestrator.md`](chat-orchestrator.md)), which reimplements
this exact pipeline (persona/peer-card/skills-catalog injection, the tool-
group classifier, Honcho storage) as real TypeScript running a raw Ollama
tool-calling loop against a real MCP client, instead of the `AI Agent`/
`MCP Client Tool` node combo documented as unreliable throughout this
file. This workflow is **deliberately still published, not deleted** —
it's the literal instant rollback for as long as it's needed (see that
doc's "what's explicitly NOT changing" section for the exact revert
procedure and the revisit trigger for when unpublishing it becomes safe).
Every gotcha below is preserved for history and because n8n's Chat
workflow itself is still live infrastructure, not because the reliability
problems it describes are still being actively worked around in the
user-facing path.

**Still published, confirmed 2026-10-13**: the most recent export
(`n8n/workflows/9YdYYhVGfsKgj4yz.json`) has `"active": true`, consistent
with this section's claim. A static export can only speak to the moment it
was taken (see [`docs/known-gotchas.md`](known-gotchas.md)'s "point-in-time
snapshot" gotcha), so this isn't a substitute for checking the live n8n UI
directly, but it's at least not contradicting the rollback story.

## 2026-09-20 — tool groups renamed/expanded, a search-retry loop, and event-bus wiring (not previously documented)

Reconstructed 2026-10-13 from the current export's node configuration and
`connections` graph (not from a live test batch — flagging that distinction
per this project's own evidence standards). Three real additions to the
pipeline since the tool-group-filtering work below, none of which had ever
been written up here:

- **The classifier groups were renamed and regrouped.** The original
  `media`/`scheduling`/`info`/`self-growth` groups (see the
  "dynamic, per-message tool-group filtering" gotcha below) are now
  `research`/`personal`/`automation`/`self-growth` in `Classify Relevant
  Tool Groups`'s JSON-Schema `format` and `Expand Groups To Tools`'s
  `GROUPS` map: `research` → `knowledge_search`/`knowledge_ingest`/
  `research_task`/`research_task_status`/`web_search`; `personal` →
  `memory_recall`/`goal_manage`; `automation` →
  `calendar_event`/`spotify_control`/`dashboard_control`/`weather_get`;
  `self-growth` → `skill_propose`/`code_task`/`code_task_status`. This
  reflects `skills-mcp`'s tool catalog having grown well past the original
  6 tools (see [`docs/architecture.md`](architecture.md)) — the old 4
  groups no longer carved it up sensibly. `calculate` and
  `task_context_manage` are unconditionally included regardless of
  classification, same "too cheap/too important to gate" reasoning
  `calculate` already had.
- **A classification-continuity input was added.** `Classify Relevant Tool
  Groups` now also calls a new `Get Last Active Capability` node
  (`GET event-bus:3004/sessions/{sessionId}/last-capability`) and folds its
  result into the classifier's own system prompt, so an ambiguous
  topic-less follow-up ("and what about tomorrow?") stays classified under
  whatever group answered the immediately preceding turn instead of
  reclassifying from scratch each time.
- **A search-retry loop was added after `AI Agent`**: `Detect Unfulfilled
  Search Intent` (Code, `runOnceForEachItem`) flags a turn for retry when a
  real capability tool was bound this turn (not just `calculate`) and
  either the agent's own reply narrates an unfulfilled intent to search/
  check/look something up (a deliberately narrow regex — "I'll/let me/hold
  on ... try/search/look/check/find" — chosen to avoid false-triggering on
  ordinary replies) or the output is genuinely empty — the latter a known,
  separate `qwen3:8b` failure mode where the model burns generation tokens
  on a specific tool combination that never resolves into text or a parsed
  tool call, with no error anywhere in the stack. `Should Retry Search?`
  routes a flagged turn through `Prepare Search Retry Nudge` back into
  `AI Agent` for one extra attempt (guarded against infinite-looping by
  checking `Prepare Search Retry Nudge` hasn't already run this execution),
  otherwise falls through to `Detect Garbage Output` as before.
- **`event-bus` integration was added at the edges of the pipeline**: the
  Chat Trigger now also fires a fire-and-forget `Publish Message Event`
  (`POST event-bus:3004/events`, `type: message_received`), `Expand Groups
  To Tools` similarly fires `Publish Classification Event` with the
  resolved `relevantGroups`, and `Format Skills Catalog` now feeds a new
  `Get Open Task Contexts` node (`GET event-bus:3004/task-contexts?
  status=open`) into `AI Agent`'s context, echoing the open-TaskContext-step
  visibility `chat-orchestrator`/`agent-service` already have for real
  traffic (see [`docs/event-bus-and-goals.md`](event-bus-and-goals.md)).
  None of these four event-bus calls appear to feed back into this
  workflow's own control flow (no downstream branch depends on their
  responses besides `Get Last Active Capability` feeding the classifier) —
  they read as parity/instrumentation work keeping the rollback path from
  falling further behind the live `chat-orchestrator` path's own event-bus
  wiring, not new user-facing behavior.

Not verified against a live execution (no test batch was run for this doc
pass) — the above is read directly from the exported node parameters and
connection graph, which is reliable for *what the nodes are configured to
do* but not a substitute for watching them actually fire.

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
  - **Fixed with dynamic, per-message tool-group filtering** — the
    `Chat` workflow gained `Classify Relevant Tool Groups` (a raw
    Ollama `/api/chat` call with a JSON-Schema `format`, same
    structured-output pattern as `skill_gap_scanner`/the coding-agent
    pipeline — deliberately not native tool-calling, since that's the
    exact mechanism proven unreliable) → `Expand Groups To Tools` (a
    Code node mapping a small set of named categories — at the time,
    `media`, `scheduling`, `info`, `self-growth`; **renamed and expanded
    to `research`/`personal`/`automation`/`self-growth` on 2026-09-20, see
    the dated entry above** — to their member tool names, the same
    coarse-"toolset" grouping pattern GitHub's own official MCP
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
  - Tools are now consumed via a `skills-mcp` MCP server (initially just
    `memory_recall`/`weather_get`; the dynamic per-message group filtering
    above narrows a much larger current catalog — see
    [`docs/architecture.md`](architecture.md)) rather than bespoke n8n
    HTTP Request Tool nodes.
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
