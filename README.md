# Smart Assistant

A self-hosted, self-learning personal AI assistant. n8n orchestrates a local
Ollama model as the "brain," Honcho (hosted cloud) provides long-term memory
of who you are, and postgres/redis back everything. Long-term goal: an
ever-growing library of skills (n8n workflows), a background job that
proposes new skills on its own (with a human approval gate before anything
goes live), and a Raspberry Pi voice interface. A Raspberry Pi smart-mirror
dashboard is already live — Amy is its data source and controller (see
"Smart-mirror dashboard" below); voice control works end-to-end except the
actual microphone/wake-word leg, still unbuilt hardware-wise.

## Architecture

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

- **n8n** — orchestrator. Skills are n8n workflows; agent-callable tools now
  live behind `skills-mcp` (below), consumed via n8n's native `MCP Client
  Tool` node rather than as bespoke HTTP Request Tool nodes per skill.
- **skills-mcp** — a small standalone MCP server (Node/TypeScript,
  `@modelcontextprotocol/sdk`, Streamable HTTP transport), its own
  `docker-compose.yml` service, internal-only (no published port — n8n
  reaches it at `http://skills-mcp:3001/mcp` over `assistant-net`). Hosts
  agent-callable tools — see `skills-mcp/src/tools/` for the current list
  (`memory_recall`, `weather_get`, `skill_propose`, `calendar_event`,
  `code_task`, `spotify_control`, `dashboard_control`, `web_search`,
  `research_task`, `research_task_status`, `research_search` as of
  this writing)
  — added by registering each in `server.ts` following the
  same `registerTool`/zod/`textResult` pattern. Names use a consistent
  `domain_verb` prefix convention (not the original `verb_noun` names some
  of these launched with — see the tool-count/naming decision below) so
  selection stays unambiguous as the tool count grows. See the gotcha
  section below for the tool-calling reliability work this unblocked, and
  the "Skill proposals" section for `skill_propose`.
- **Ollama** — local LLM inference (GPU). `OLLAMA_KEEP_ALIVE=-1` plus an
  `ollama-warmup` one-shot service keep the default model resident in VRAM
  at all times, so there's no cold-start tax after the stack comes up.
- **Honcho** (hosted, [app.honcho.dev](https://app.honcho.dev)) — long-term
  memory / user modeling, with a web dashboard to see what it has learned.
  This is the one deliberate exception to "everything else is local and
  free" — it needs a real API key. Self-hosting was tried and abandoned;
  see `honcho-src/` note below.
- **postgres** (`pgvector/pgvector:pg16`) — backs n8n itself (`n8n` database)
  and the Postgres Chat Memory node, plus a separate `research` database
  (see "Research workflow" below) that's the first real consumer of
  pgvector: `research_chunks.embedding` is a genuine `vector(768)` column,
  populated by the `nomic-embed-text` Ollama model.
- **redis** — provisioned, not yet wired into anything specific.

## Honcho peer cards (proactive memory + behavioral instructions for Amy)

Beyond the reactive `memory_recall` tool (which only fires when the LLM
decides to call it — unreliable, see the tool-calling gotcha below), the
`Chat` workflow now injects two Honcho **peer cards** directly into Amy's
system prompt every turn, via plain HTTP Request nodes (`Get User Card`,
`Get User Card For Amy`) — no tool-calling involved, so it can't be skipped:

- **`user`'s own card** — durable facts about the user (name, age,
  education, job search status, etc). This is Honcho's default
  self-representation of peer `user`.
- **`user`'s directional card *for* `amy`** (`target=amy`) — standing
  instructions/goals for how Amy should behave, from the user's
  perspective (e.g. "GOAL: assist the user with everything possible",
  "TRAIT: butler-type personality"). This requires `observe_others: true`
  to be set for peer `user` on the session (the `Set User Observe Config`
  node does this, idempotently, every turn) — without it, Honcho has no
  directional `(observer=user, observed=amy)` representation to draw a
  card from. `Ensure Session Exists` (a `POST .../sessions` get-or-create
  call) runs immediately before this and is required: Honcho sessions are
  otherwise only created lazily by the message-store call at the *end* of
  the turn, so without it, the very first turn of any new session would 404
  on the config PUT (session doesn't exist yet) and silently skip setting
  `observe_others` for that session's whole lifetime. See Honcho's
  [representation scopes
  docs](honcho-src/docs/v3/documentation/features/advanced/representation-scopes.mdx)
  for the observer/observed model this relies on.

Both cards start out populated from a one-time manual bootstrap
(`node scripts/set-peer-cards.mjs`, requires `HONCHO_API_KEY` in the
environment) rather than waiting for Honcho's automatic "dreaming"
consolidation (which only runs after a threshold of new conclusions + an
idle period — see Honcho's dreaming docs). From here, dreaming should keep
both cards updated as real conversations accumulate; `set-peer-cards.mjs`
is safe to re-run (it replaces the whole card, doesn't merge) if you want
to hand-correct something.

We deliberately did **not** add a third card — Amy's directional view of
`user` (`observer=amy, observed=user`) — since Amy is present in literally
every session with the user, so that representation would reason over the
exact same messages as `user`'s own self-card, doubling Honcho's background
reasoning cost for no real gain. Revisit if a second persona/agent that
*doesn't* sit in every session is ever added.

Both HTTP nodes have `onError: continueRegularOutput` set — if Honcho is
briefly unreachable, or a card is empty/not-yet-created, the expression that
builds Amy's system prompt falls back to just the base persona text rather
than breaking the chat.

## Persona system

The agent's identity lives in a `personas` Data Table in n8n (not in the
workflow JSON), one row per persona. Currently one row: **"Amy"** — a
written character/tone system prompt, not a neutral tool voice. The `Chat`
workflow's `Get Persona` node reads the `system_prompt` column for that row
and feeds it to the AI Agent as its system message, alongside the two
Honcho peer cards described above.

**2026-07-27 — the model had no way to know the actual current date,
and silently fabricated one.** Asked to schedule a calendar event
"tomorrow at 5pm," `calendar_event` reported success with a real event
ID and a real Google Calendar link — but the event was actually created
for `2023-10-12`, over three years in the past. Confirmed directly by
fetching the event from Google's API by ID (not visible via `list`'s
default 7-day window at all, which is exactly why it looked like
nothing happened). Root cause: nothing in the system prompt ever told
the model what "today" actually is, so a relative date like "tomorrow"
had no ground truth to compute from and it fell back to some
training-era placeholder date instead of erroring or asking. **Fixed**
by injecting the real current date/time (`$now`, formatted in Pacific
time — n8n's expression engine, not a tool call, so no reliability
concerns) directly into `AI Agent`'s `systemMessage`, with explicit
instruction to use it as ground truth for relative dates and never
guess. Verified: the identical request afterward correctly created an
event on `2026-07-28` (genuinely tomorrow) — cleaned up both the wrong
and the corrected test events afterward.

**Same day, real usage hit it again — the injection fix isn't 100%
reliable, root cause not fully pinned down.** In a real multi-turn
conversation, the *same* deployed workflow (no restart in between)
produced a genuine, real-calendar event dated `2023-10-18` — three
turns after an earlier turn in the identical conversation that *had*
correctly included the injected date. Pulled the raw execution data for
both: the earlier turn's system message genuinely contained "Right now
it is..."; the later one's didn't — same persona text before and after
it, just that one line missing, not a formatting/parsing issue on my
end. Tried to reproduce with a simple multi-turn follow-up and with a
separate tool-calling round-trip (checking *both* of the agent's
internal LLM calls, before and after the tool result) — neither
reproduced it. Genuinely intermittent, cause not identified.

Given a wrong calendar entry is a real-world consequence, not just an
odd reply, this isn't something to leave resting entirely on "the LLM
had the right context most of the time." **Added a deterministic
safety net in `calendar_event` itself**, independent of the model's
context: `create`/`update` now reject any `start`/`end` more than 1
year in the past or 2 years in the future, with an error that states
the *actual* current date so the model can self-correct on retry —
same "give it a clear, actionable error" pattern as `spotify_control`'s
`NO_ACTIVE_DEVICE` handling. Verified: a deliberately wrong 2023 date is
now rejected outright; a real, correct date still succeeds normally.
Both the original bad event and the two verification test events were
cleaned up from the real calendar afterward.

**2026-07-26 decision**: there used to be a `propose_persona_change` tool
(and a human-approval-gate workflow around it) that let the agent write a
*candidate* system-prompt rewrite for a human to review and manually apply.
It's been removed as superseded, not just left dormant — its job (getting
user feedback about Amy's behavior to actually change her behavior) is now
done automatically and continuously by the `user`→`amy` peer card, with no
LLM guessing and no review step needed. Keeping a second, redundant,
human-gated mechanism for the same purpose was more moving parts for no
remaining gap. If Amy's *foundational* character/tone ever needs a
deliberate rewrite (not just accumulated behavioral instructions), that's a
product decision for a human to make directly in the Data Table — not
something to re-introduce a proposal workflow for.

**2026-07-26 decision — tool guidance lives in the tool, not the persona.**
The persona prompt used to carry a per-tool "When to use the
memory_recall tool:" section, duplicating guidance that already
belongs in that tool's own MCP `description` (per Anthropic's own tool-use
guidance: descriptions should state what a tool does, when to use it, and
when not to — "aim for at least 3–4 sentences," extremely detailed). That
section has been removed, and every `skills-mcp` tool's own description was
strengthened to be fully self-contained instead — no duplication, one
source of truth per tool, and new tools (`weather_get`, `skill_propose`,
calendar tools) never got persona-level sections added in the first place.
The persona keeps only one general, non-tool-specific line: check whether
you can already answer before reaching for any tool — a behavioral
disposition, not documentation for any particular tool.
- **Verified no regression**: 0/5 garbage on plain greetings post-change,
  `weather_get` and the Honcho peer-card-based memory recall both still
  work correctly, character/voice intact.
- **Did not fix `skill_propose`'s reliability gap.** Re-tested the same
  scenario that previously produced empty native output (asking about a
  smart-home capability gap with an explicit nudge to propose a skill) —
  still 3/3 empty completions after this change. This confirms the
  underlying issue is a deeper native-tool-calling limitation in how
  `qwen3:8b` reasons through a more complex/reflective tool decision via
  n8n's LangChain integration, not something fixable by prompt engineering
  on either the persona or the tool description. The safety net still
  handles it correctly (verified: fallback produces a graceful, in-character
  answer, nothing crashes) — it just means `skill_propose` specifically
  has a lower real invocation rate than the simpler tools, independent of
  how well-described it is.

**2026-07-27 decision — consolidate + namespace tools before the count
becomes the reliability problem.** Both Ollama's own structured-outputs
guidance and Anthropic's tool-design guidance independently say the same
thing: small models pick the *right* tool less reliably as the tool count
grows, recommending 3–5 tools and consolidating related actions into one
tool with an action parameter rather than many single-purpose tools. We
were at 7 (`recall_user_memory`, `get_weather`, `propose_new_skill`, and
four separate calendar tools) — above that range. Changes:
- The four calendar tools (`list_calendar_events`, `create_calendar_event`,
  `update_calendar_event`, `delete_calendar_event`) were consolidated into
  one `calendar_event` tool with an `action` enum (`list`/`create`/
  `update`/`delete`) — same underlying `lib/google-calendar.ts` calls,
  cross-field validation (e.g. `eventId` required for `update`/`delete`)
  moved into the handler, mirroring the pattern `skill_propose`'s
  `kind`-based validation already used. Down to 4 tools total.
- All four tools renamed to a consistent `domain_verb` prefix (`memory_recall`,
  `weather_get`, `skill_propose`, `calendar_event`) instead of the
  inconsistent `verb_noun` names they launched with individually — matches
  Anthropic's own namespacing guidance ("prefix names with the
  service... especially important as your tool library grows").
- **Verified no regression** after rename: 0/3 garbage on greetings,
  `weather_get` and `memory_recall` both work correctly (the latter
  correctly surfaced a genuine conflicting-preference recall from Honcho),
  `calendar_event` responded gracefully when unconfigured. `Detect Garbage
  Output`'s internal-tool-name-leak regex was updated to match the new
  names — this is exactly the kind of hardcoded-name dependency worth
  checking for on any future tool rename.
- This is a one-time reorganization, not the dynamic-tool-filtering
  mechanism discussed as a further-out option (only bind the subset of
  tools relevant to the current turn) — that's a bigger, separate change,
  worth revisiting only once the tool count grows enough to hit this
  ceiling again.

**Back up to 5 with `code_task`** (the coding-agent pipeline's reactive
trigger — see below). A deliberate addition, not scope creep sliding back
past the guidance above: it's a genuinely new capability with no existing
tool to consolidate it into, and it sits right at the edge of the 3–5
range rather than past it. Worth revisiting the dynamic-tool-filtering
option for real if anything gets added beyond this.

An `update_context` workflow also exists in n8n, inactive, and is currently
an empty stub (no nodes) — a reserved name/slot for something not built
yet, not a working feature.

**2026-07-27 — 6th tool, `spotify_control`, added deliberately past the
3-5 guidance.** Playback control (`play`/`pause`/`next`/`previous`/
`current`/`search`/`queue`/`volume`, one consolidated tool with an
`action` param, same shape as `calendar_event`) via `lib/spotify.ts` and
a one-time OAuth bootstrap (`scripts/spotify-auth.mjs` — Spotify has no
service-account equivalent to Google Calendar's key file; playback acts
on a specific person's account, so a real 3-legged authorization is
unavoidable, just a one-time cost). User explicitly chose to add this
now rather than build dynamic tool filtering first — "build as we need."

**Real bug found and fixed the same day, with a concrete mechanism, not
just "the model is unreliable"**: asking Amy to skip a song produced an
empty `AI Agent` output and no tool call at all. The raw model
completion (pulled directly from the execution data, not inferred)
showed the model's think-mode reasoning explicitly getting stuck on a
genuine contradiction: `spotify_control`'s own description said to
"relay [a no-active-device error] plainly," while the persona's system
prompt has a blanket "never mention a tool failure, proceed as if you
hadn't tried" rule. The model spent its whole turn arguing with itself
over which instruction to follow ("Wait, no—the user's instruction
says... Hmm. Maybe I should still attempt the call...") and the
generation ended right after concluding "proceed with the call" —
never actually emitting the tool call. Not a refusal, not confusion
about the tool itself — a self-inflicted contradiction between a
per-tool override and a persona-wide rule.

**Fixed** by removing the conflicting clause from `spotify_control`'s
description (verified: re-running the identical request afterward shows
`MCP Client Tool` actually executing and returning a real result).
**Audited the other 5 tools' descriptions for the same pattern — none
had it.** To prevent recurrence, added a convention comment directly in
`skills-mcp/src/types.ts` (imported by every tool): tool descriptions
must describe what a tool does and when to use it, never how to handle
a failure — that's a cross-cutting concern the persona alone governs.
A per-tool override of it isn't just redundant, it's actively harmful,
since it can send a reasoning model into exactly this kind of stuck
deliberation.

**On whether MCP itself is being "used right"**: yes, structurally — a
stateless per-request server, zod-validated schemas, and action-enum
consolidation to manage tool count are the same patterns large official
MCP servers use (e.g. GitHub's official server ships 33 tools via
grouped "toolsets"). This bug was never an MCP problem — `tools/list`
correctly exposed `spotify_control`'s schema throughout, and the
`/mcp` endpoint behaved exactly as designed. The actual fragility is
entirely on the *consumption* side: n8n's LangChain AI Agent driving
tool-calling decisions through a small local model (`qwen3:8b`) via
Ollama, which is the same integration this project has already
documented real reliability problems with (see the tool-calling gotcha
below, and `skill_propose`'s under-invocation). MCP the protocol isn't
the bottleneck; a small local model reasoning its way through tool
selection is.

**2026-07-27 — real usage after all the above found a genuine Spotify
Web API quirk, not another model/reliability issue.** After the tool-
calling fix above, real usage surfaced `spotify_control failed:
Unexpected token 'l', "lrWzm3vrhZ"... is not valid JSON` on `next` and
`queue`. Root-caused with a temporary debug log (status/headers/raw
body) rather than guessing: Spotify's docs say these player-control
endpoints (`next`/`previous`/`queue`, and sometimes `pause`) return
`204 No Content` on success — in practice, they can instead return
`200` with a short opaque, non-JSON body and no `content-type` header
(observed directly: `status=200 content-type=null body="lrWzm3vrhZ...`,
27 characters). `lib/spotify.ts`'s `spotifyFetch` only special-cased the
documented `204` case, so the undocumented `200`-with-garbage-body case
fell through to a hard `JSON.parse` failure. **Fixed**: any non-JSON
body on an otherwise-OK response is now treated as "no data" (same as
204) rather than a failure — correct regardless of *why* Spotify
sometimes does this, since none of the player-control callers use the
response body anyway. Verified: `next`/`previous`/`queue` all fixed,
`current`/`pause`/`search` (which do parse real JSON bodies) unaffected.

**2026-07-28 — 7th tool, `web_search`, added because a real gap surfaced
directly.** A user request via `discord-bot` ("build a script that outputs
today's headlines") triggered `code_task`, which correctly wrote a coding
task — but the stack had no way to actually source real headlines from
anywhere; the resulting script could only ever fabricate content. Rather
than let the coding pipeline paper over a missing capability, added
`web_search` (`skills-mcp/src/tools/web-search.ts` + `lib/tavily.ts`),
backed by [Tavily](https://tavily.com)'s search API (free tier, no card
required — the one other deliberate external-API-key exception besides
Honcho, same "optional, clear config-missing error at call time" pattern
Google Calendar/Spotify/dashboard use; `TAVILY_API_KEY` in `.env.example`).
Takes `query`, an optional `topic` (`'news'` biases results toward the last
few days, for headline-style asks specifically), and `maxResults`. Wired
into the `Chat` workflow's `Classify Relevant Tool Groups`/`Expand Groups
To Tools` classifier as a new `web` category — via the documented `n8n
export:workflow --published` → edit → `import:workflow` → `publish:workflow`
→ restart CLI cycle (no UI access in this environment; see the
`n8n-publish-system` gotcha), since a direct DB edit wouldn't have taken
effect. **Verified end-to-end against the real running stack, not just a
typecheck**: pulled the raw execution data for a live test chat message
directly from Postgres (`execution_data`) and confirmed `web_search` was
actually invoked by the agent (not just present in `tools/list`) and
correctly returned a "not configured" error pre-`TAVILY_API_KEY`, which the
persona's existing "never mention tool failures" rule handled gracefully
(the user-facing reply offered general knowledge instead, no raw error
leaked) — same safety net every other optional tool already relies on.
Past the 3-5 guidance discussed above, same as `spotify_control` and
`code_task` before it — added because a concrete, just-observed gap
justified it, not as routine growth.

**Restarting n8n mid-flight has a real cost, observed directly during this
change**: the publish cycle's required restart interrupted an in-progress
`coding_task_pipeline` execution (the same headlines-script task that
motivated `web_search` in the first place) — n8n's own shutdown log showed
it waiting on 3 active executions before restarting anyway, and that
execution's row in `coding_proposals` was left permanently stuck at
`status: "running"` with nothing left to ever update it, since the
execution that would have updated it was gone. Manually corrected the
stale row to `needs_review_failed` with a `latest_status` explaining the
interruption, rather than leaving a misleading "running" status with no
process actually behind it. Worth knowing for next time: **a workflow
publish that requires a restart can silently orphan any coding task that
happens to be mid-run** — no automatic detection or recovery of this exists
yet.

## Event bus + goals

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
directional card (see "Persona system" above) shape nudge tone/frequency —
e.g. a "don't nag" trait should make her back off — instead of one
hardcoded string for everyone.

## Skill proposals (self-authoring, human-gated) — first step toward self-growing skills

Generalizes the same "propose, never auto-apply" pattern the old
`propose_persona_change` used (see above), applied to a general
skill/capability library instead of just the persona prompt. This is the
**reactive** half of the project's long-term self-growing-skills goal — the
agent proposing something when it hits a gap mid-conversation — not the
larger autonomous background-job vision, which stays deferred.

**Skills and tools are not the same thing** — two different layers of gap,
consumed in completely different ways once approved:
- **`instruction` skill** — plain-text procedure ("how to do X"), no code.
  The agent can fully draft this itself. Once a human flips its `status` to
  `"active"` in the Data Table UI, it's consumed exactly like the peer
  cards above: **injected directly into every turn's system prompt**
  (`Get Active Skills` → `Format Skills Catalog`, see architecture diagram)
  — no tool call needed to "load" it, the instructions are just already
  sitting in context. Deliberately avoids a `use_skill` tool-call as the
  activation mechanism, which would reintroduce native tool-calling
  unreliability for something that doesn't need it.
- **`tool_idea` skill** — a request for a genuinely new capability that
  needs real code (a new `skills-mcp` tool). The agent can only describe
  it, not build it — a human has to actually implement and deploy it
  (following the existing `registerTool`/zod/`textResult` pattern other
  tools use) before it's usable. Once that's done, discovery works exactly
  like any other tool already does — no special mechanism, just a
  well-written tool `description`.

Both kinds are proposed through one MCP tool, `skill_propose` (in
`skills-mcp`), which POSTs to a small n8n workflow (`skill_proposal_intake`,
webhook → Code node → Data Table row insert → Respond to Webhook) that
inserts a new row into the `skills` Data Table with `status="proposed"`. A
human reviews proposed rows in the Data Table UI and manually flips
`status` to `"active"` or `"rejected"` — the only thing marking an
`instruction` skill active does is make `Get Active Skills` start including
it; nothing else needs to change.

`skills` Data Table columns: `name` (kebab-case, agent-authored, validated
against Anthropic's [Agent Skills
spec](https://agentskills.io/specification) naming rules — lowercase,
hyphens only, no leading/trailing/consecutive hyphens, ≤64 chars),
`description` (≤1024 chars — the tool's own schema instructs the model to
state both *what* it does and *when* to use it, quoting the spec's
good/poor example contrast directly), `kind` (`instruction`/`tool_idea`),
`instructions` (full body, `instruction` kind only), `tool_idea_details`
(inputs/outputs/why-not-covered, `tool_idea` kind only), `reason` (why this
would help), `status`. n8n's auto `createdAt`/`updatedAt` are used directly;
no separate `proposed_at` column needed.

**Verified working end-to-end**: proposing both kinds through a live chat
turn correctly inserts rows; approving an `instruction` skill (flipping
`status` to `active`) and starting a *fresh* session demonstrably changed
Amy's behavior to follow that skill's specific instructions, with zero tool
calls involved in "loading" it.

## `skill_gap_scanner` (autonomous self-reflection, human-gated)

The **autonomous** half of self-growing skills — a scheduled n8n workflow
(`skill_gap_scanner`, daily at 3am) that reflects on recent activity
without being asked, instead of waiting for the agent to notice a gap
mid-conversation and call `skill_propose` itself (which it doesn't always
do, even for genuine gaps). Reflects across four dimensions the user asked
for: capabilities, functionality, personality, and knowledge. Two
independent branches off one `Schedule Trigger`, both read-only against
Honcho/Data Tables except one write each — never a direct write to
anything currently live/consumed, same human-approval philosophy as
`skill_propose`.

**Branch A — capabilities + functionality + knowledge → `skills` table.**
Asks Honcho's dialectic endpoint (unscoped, `peers/user/chat`, no
`sessionId`) one broadened question covering all three: things the agent
couldn't help with, existing tools/skills that misbehaved, and general
knowledge it was shaky on. Feeds that plus the full existing `skills` list
to a raw Ollama `/api/chat` call (not the LangChain AI Agent node — same
`format`-JSON-Schema structured-output pattern as `Ollama Direct Fallback`
in `Chat`) asking it to return a **list** of proposals — zero, one, or
several — one object per genuine, distinct, recurring issue, prefixing
each `reason` with `Capability gap:` / `Functionality issue:` / `Knowledge
gap:` so a human reviewer knows which. **Not originally designed this
way** — the first version constrained the schema to a single proposal
object, and a live test (real chat messages creating two genuinely
distinct, recurring gaps at once) showed the older, more-repeated gap
winning every time even though the newer one's signal was clearly present
in `Query Gap Summary`'s own output — the single-object schema forced a
choice between them instead of surfacing both. Switched to
`{proposals: [...]}`; the downstream `If Should Propose` → `Submit
Proposal` nodes needed **no changes at all** — n8n fans out multi-item
Code node output through IF/HTTP Request nodes per-item automatically, so
letting `Parse and Normalize Proposal` return one item per valid proposal
was the whole fix. That Code node **deterministically kebab-cases each
`name`** independently and drops duplicates within the same batch before
submitting — Ollama's structured output is reliably valid JSON but not
reliably kebab-case (`format` constrains shape, not string content), so
this is a real, verified-necessary normalization step, not a
nice-to-have. Each valid proposal submits separately through the exact
same `skill_proposal_intake` webhook `skill_propose` already uses — no
new proposal mechanism, no new review UI, same `skills` Data Table, same
`status="proposed"` gate.

**Branch B — personality → `personas` table.** Answers the question of
whether this needed bespoke reflection logic: no. Honcho's own Dreamer
already builds a self-representation for any peer with `observe_me=true`
(the default), and Amy's own replies have been stored via `peer_id: 'amy'`
in `Chat`'s Honcho-storage node since the beginning — so Amy has had a
self-representation this whole time, and Honcho's Dreamer InductionSpecialist
already extracts "personality traits: stable characteristics inferred from
multiple data points" from it during self-observation dreams
(`observer == observed`), writing them onto Amy's own peer card via its
`update_peer_card` tool. This branch just triggers a fresh self-dream
(`POST .../schedule_dream` with `observer`/`observed` both `"amy"` —
best-effort, Honcho's own cooldown/threshold logic still governs whether a
dream actually runs), reads Amy's self-card (`GET /peers/amy/card`, no
`target` — confirmed in Honcho's `get_peer_card` route that omitting
`target` returns the peer's own card), and asks Ollama whether it
surfaces anything not already reflected in the live `system_prompt`. If
so, it writes to `proposed_system_prompt`/`proposed_reason`/`proposed_at`
on Amy's `personas` row — dormant columns left over from the removed
`propose_persona_change` workflow, reused here rather than adding new
schema. A human reviews the same way as `skills`: open the row, and if
it's good, manually copy `proposed_system_prompt` into `system_prompt`.
Nothing automated ever touches `system_prompt` itself.

**Verified working end-to-end** against the live stack (the real running
n8n server, not just a one-off CLI execution — n8n's `execute` CLI command
spins up an isolated sub-process where Data Table nodes report "module is
disabled," which is a testing-environment quirk, not a workflow bug; a
temporarily-shortened schedule interval confirmed both branches against
the actual server instead): a full real run correctly read genuine gap
history from Honcho (a recurring, never-formally-proposed request for
salary-negotiation guidance, visible across several real past
conversations) and submitted exactly one well-formed, correctly
kebab-cased `proposed` row for it; the personality branch correctly read
Amy's real `system_prompt` and real self-card and correctly decided
*not* to propose a change, since her current persona already covers what
the self-card surfaced (butler-like formality, discretion/competence/
loyalty, "sir") — `personas.proposed_*` stayed empty, exactly the intended
no-signal behavior.

**Follow-up: a synthetic test suite covering all six paths, since the
project's real Honcho history only ever exercises one of them.** With
real usage this limited, an organic run can really only ever hit the
capability-gap path (the one real recurring gap that exists) — functionality
issues, knowledge gaps, a genuinely novel personality trait, and an empty
self-card had never actually been exercised. Rather than pin data (see the
gotcha below — doesn't work for this), each scenario temporarily swaps the
relevant upstream node(s) for a literal Code node returning fixed synthetic
output, deploys with a throwaway `Execute Workflow Trigger` for one-off CLI
runs, and reverts afterward. All six passed with correctly-reasoned,
correctly-shaped output: a capability gap (recurring reminder request),
a functionality complaint (wrong email recipient), a knowledge gap (a
board-game rules question), a no-signal case (nothing to report), a novel
personality trait (proactive wellbeing nudges — correctly distinguished
from what the persona already covers), and an empty self-card (correctly
no-op). This round of testing found and fixed three real bugs:
- **`Submit Proposal` and `Submit Persona Proposal` had no `onError`
  handling** — a transient failure on either terminal write node would
  have hard-failed the *entire* execution (both branches share one
  Schedule Trigger run), not just logged a quiet miss. Added
  `onError: continueRegularOutput` to both, matching every other node in
  this workflow that touches an external system.
- **The kebab-case `name` normalization truncated in the wrong order.**
  `.replace(/^-|-$/g, '').slice(0, 64)` strips leading/trailing hyphens
  *before* truncating — so a name whose 64th character happened to land
  on a hyphen still came out with a trailing hyphen
  (`...cover-letter-`), which is exactly the malformed shape this
  normalization step exists to prevent. Fixed by truncating first, then
  stripping: `.slice(0, 64).replace(/^-|-$/g, '')`.
- Confirmed **`Submit Persona Proposal`'s `update` operation actually
  writes for real** — the CLI-only "Data table module disabled" quirk
  had masked this every time it came up during testing (it kept
  degrading gracefully instead of actually running), so the real write
  path was unverified until a mocked-but-guaranteed-positive scenario was
  run through the real server instead of the CLI.

**Follow-up: a live demo with real chat messages, no mocking at all.**
Sent real messages through the actual `Chat` webhook to create genuine
gaps: asking Amy to control smart lights (which — nicely — triggered her
*reactive* `skill_propose` mid-conversation on its own, before the
scanner ever ran), a passing complaint that a weather report was wrong
once (correctly ignored as a one-off, per the query's own instruction),
then a follow-up making that same complaint recur (correctly picked up:
Honcho's dialectic response explicitly said "weather information has
been inaccurate more than once recently"), and an obscure board-game
rules question (correctly stayed a one-off, never proposed). Running the
real scanner against this — waiting for Honcho's background deriver to
actually index the new messages first, since the dialectic endpoint can
only surface what's already been derived — is what surfaced the
single-proposal-per-run limitation described above: the real run's raw
`Query Gap Summary` output *did* contain the weather signal, but the
single-object schema at the time let the model surface only the older,
more-repeated salary-negotiation theme instead. After the fix (see
above), a follow-up mocked scenario with two simultaneous, genuinely
distinct gaps (a translation capability gap + a historical-knowledge
gap) correctly produced two separate proposals from one Ollama call in
one run, submitted as two separate webhook calls, confirming the fix
without needing to wait for real signals to naturally recur again.

**Honest limitations**: (1) signal sparsity — this project has limited
real usage history, so expect `shouldPropose: false` most nights in both
branches, not a sign of malfunction. (2) The model name (`qwen3:8b`) is
hardcoded separately in this workflow's two Ollama HTTP nodes (`Ollama
Reasoning`, `Personality Reasoning`) — there's no n8n mechanism for one
workflow to read another's node parameter live, unlike `Ollama Direct
Fallback`'s same-workflow `$node[...]` trick, so this is a second place to
update if the model changes again. (3) A personality proposal has no
consumer beyond a human manually copying it over — same manual-approval
pattern as `skills`, just a different table, and currently the only
thing that ever reads or writes `proposed_system_prompt`/`proposed_reason`/
`proposed_at` at all.

**2026-07-27 — the opposite of sparsity showed up in practice: the same
gap re-proposed under different names.** With enough real days of
scanning, the same salary-negotiation gap got proposed four separate
times under four different kebab-names (`salary-negotiation-workflow`,
`negotiate-salary-offer-instruction-proposed`, then two more on later
runs) — `Ollama Reasoning`'s system prompt already says never to
repropose an existing/equivalent skill, and one rejected proposal's own
`reason` field even *named* an existing proposal as related, then
proposed anyway. The within-batch dedup (`Parse and Normalize Proposal`'s
`seen` Set) only catches exact-name collisions in the same run — it
never checked new candidates against the full existing `skills` list at
all. A word-overlap heuristic was tried first and measured to fail on
the exact real case (different phrasing/synonyms score too low on raw
word overlap despite being the same underlying idea — "a fully
implemented, saved skill providing a reusable workflow" vs. "a
structured, repeatable guide" share almost no literal words). Fixed with
a new **`Semantic Dedup Check`** step between `Parse and Normalize
Proposal` and `If Should Propose`: a dedicated Ollama call given the full
candidate list plus every existing skill (any status), asked to judge
duplication by substance, not wording — this is what a real LLM judgment
call is good at, unlike string matching. Verified against the live
scanner (temporarily shortened schedule, same technique as elsewhere in
this project) correctly filtering out three different re-worded
salary-negotiation variants across separate runs, with `Submit Proposal`
never firing for any of them.

Building this surfaced a real, previously-invisible bug affecting
already-shipped code: **global `fetch()` is not defined inside a Code
node's sandboxed execution context** in this n8n version — confirmed by
direct testing (`ReferenceError: fetch is not defined`, thrown from
`js-task-runner.js`'s `vm.runInContext`). The dedup node's first draft
used `fetch()` and failed in under 20ms every time, silently caught by
its own error handling. Worse: `dashboard_state`'s `Catalog Ready` node
(see "Smart-mirror dashboard" above) used the exact same pattern and had
been hitting its catch block on *every single run* since it was built —
never once actually reaching the Pi's `/api/widgets/catalog` endpoint —
completely undetected because its hardcoded fallback catalog happens to
have identical content to the real one. Fixed both nodes to use
`this.helpers.httpRequest(...)` instead (the sanctioned way to make HTTP
calls from inside a Code node) — confirmed genuinely fixed by real
network round-trip timings afterward (500ms–1.1s) replacing the previous
instant, fallback-only executions (8–15ms).

**2026-07-28 — Branch C: reading raw transcripts to catch corrected
procedures, not just gaps.** Branch A's dialectic-based gap detection is
good at surfacing *themes* ("the user keeps asking about X") but isn't
built to faithfully reproduce a literal sequence of steps — and the user
specifically wanted something different: catch it when they had to
correct Amy's approach two or more times in a row before something
finally worked ("no not that, do this... actually check this first...
now that worked"), and turn the *actual corrected procedure* into a
detailed, step-by-step `instruction` skill proposal. That needs the real
message text, not Honcho's synthesized answer, so this reads raw
transcripts directly via Honcho's `sessions/list` and
`sessions/{id}/messages/list` endpoints (confirmed these exist via
Honcho's own API docs — this project had never called them before, only
ever the dialectic `peers/.../chat` endpoint and the message-insert
endpoint used to store chat turns).

Feeds into the exact same `Semantic Dedup Check` → `If Should Propose` →
`Submit Proposal` chain Branch A already uses, completely unchanged — a
second Code node (`Parse Correction Proposal`) simply became a second
incoming connection into the existing `Semantic Dedup Check` node,
alongside `Parse and Normalize Proposal`'s existing one. No new Data
Table, no new review mechanism, same human-gated `skills` table.

**A real, live-verified surprise before wiring anything in**: this
workspace's `sessions/list` is not just real chat conversations — it's
full of single-message, `amy`-only "sessions" from the coding-agent
pipeline's own proactive chat notifications (e.g. `"Finished: ..."`),
manually-named test sessions from earlier debugging (`root-cause-test-*`,
`full-run-test-*`), and other throwaway artifacts. Simply grabbing "the
last 5 sessions" would have reliably returned only this junk, never a
real conversation — confirmed directly (the newest 5 by creation time,
live, were all one-way test/notification sessions with zero real
back-and-forth). Fixed by fetching a wider window (30) and filtering to
sessions with at least one `user`-authored message (a real chat turn
always inserts a user+amy pair together, per the `Chat` workflow's own
message-insert node — a one-way notification never has a `user` message
at all) — confirmed this filter correctly separated 9 genuine
conversations out of 30 raw sessions in this workspace's real data.

Also verified live before depending on it: `reverse=true` on
`sessions/list` is newest-created-first, `reverse=false` on
`messages/list` is chronological — Honcho's own docs didn't fully specify
the underlying sort key, so this was checked directly against the real
API rather than assumed.

**A real bug found via a live end-to-end test, not just isolated
per-node checks**: `Parse Correction Proposal`'s first version assumed
n8n's Code node runs once per input item by default — it doesn't; the
default is "run once for all items," with `$json` referring to a single
item only. `Detect Correction Pattern` (an HTTP Request node, which
*does* run once per item by default) correctly produced 8 separate
results for 8 candidate sessions in one real test run — two of which
were genuine `found: true` corrected procedures — but `Parse Correction
Proposal` silently processed only one of the 8, dropping both real
detections without any error anywhere. Exactly the kind of thing that
only shows up under a real multi-item run, not a single hand-crafted
test case. Fixed by iterating `$input.all()` and collecting every match,
mirroring `Parse and Normalize Proposal`'s own already-correct pattern.
Re-verified against a second live run afterward: both genuine corrected
procedures (a Spotify-display capability clarification and a dashboard
widget-layout correction, both real, from this project's own actual
usage) correctly survived semantic dedup and landed as real `proposed`
rows in the `skills` table, each with a detailed, literal, numbered
procedure — not a one-line gap description.

Also caught and fixed via direct testing before deploying: the
`Detect Correction Pattern` prompt's first draft let the model bleed its
required `'Corrected procedure:'` prefix into the `name` field too
(intended only for `reason`), producing an ugly, needlessly-long kebab
name. Fixed by explicitly telling the prompt the `name` field must be
short and plain with no prefix — confirmed fixed by re-running the exact
same test transcript before and after the wording change.

**Same day, real user feedback on the actual generated proposal**: the
`dashboard-layout-adjustment` proposal above looked reasonable in
isolation, but the user immediately flagged the real problem — it was
hardcoded to "swap Spotify and calendar," a literal transcript of one
specific instance, not an actually reusable skill. Root cause was the
prompt itself: `Detect Correction Pattern`'s instructions explicitly said
to extract "the literal steps that worked, using the same terms the
conversation actually used" — exactly the kind of instruction that
prevents generalization. Fixed by explicitly having the prompt
distinguish what's *specific to this one request* (which widget, which
exact position) from the *general, reusable procedure* the correction
actually reveals (check the real current state before changing or
reporting anything, work out what the request implies, apply only that
change, then verify and accurately report what happened) — while still
keeping genuinely technical specifics (real commands, tool names, exact
configuration) literal where THAT specificity is what makes a procedure
useful, rather than vague-ing everything into generic advice. Verified
directly against the same real transcript before and after: went from a
literal "swap Spotify and calendar" instance to a general
"verify-current-state → apply-change → report-accurately" procedure.

The identical problem existed in Branch A too — it had no such
instruction at all, and a synthetic test with the same fix applied
confirmed it: a recalled incident about diagnosing a parasitic battery
drain on one specific Porsche model first came back as
`name: "Diagnose parasitic battery drain in Porsche 987"` with the model
name baked into the proposal's identity even though the actual
`instructions` steps (multimeter, fuse-pulling, continuity checks) were
already genuinely generic. Extended the fix to require the `name` and
`description` fields to generalize too, not just `instructions` — the
same test then produced `"Diagnose Parasitic Battery Drain in Vehicles"`
with no vehicle-specific detail anywhere in the proposal. Applied to both
branches' prompts (`Ollama Reasoning` for Branch A, `Detect Correction
Pattern` for Branch C) so a future proposal from either path is judged
by whether it would genuinely help with a *different but similar* future
situation, not just whether it accurately recorded what happened once.

## Coding-agent pipeline + sandbox (in progress)

The next step beyond `skill_propose`/`skill_gap_scanner`: those can only
ever *describe* a gap (`tool_idea`) — a human still has to write the code.
This is a pipeline that can plan, write, and test real code changes in an
isolated sandbox, for both self-improvement (this project) and
general-purpose coding help on other projects, always ending in a
human-reviewed proposal, never an auto-applied change. Full design in
`.claude/plans/` history; only the pieces actually built so far are
documented here.

**Built and verified so far:**
- This project is now a git repository (local only — no remote yet, since
  that's a manual step requiring GitHub access not yet available). Every
  target repo the pipeline will operate on, including this one eventually,
  is referenced uniformly as `{ repoUrl, ref }` and always cloned fresh
  over the network inside an ephemeral container — **never** a bind-mount
  of a host folder. This was a deliberate choice, not the original plan:
  Docker-outside-of-Docker sibling containers are spawned by the *host*
  Docker daemon, so a bind-mount source has to be host-resolvable, and (see
  gotcha below) bind mounts have independently proven flaky on this exact
  machine. Cloning over the network sidesteps that entirely.
- **`sandbox-runner`** (new service, `sandbox-runner/`): a narrow,
  stateless HTTP service — `POST /execute` takes `{ repoUrl, ref, patch?,
  testCommand, timeoutSeconds? }` and returns `{ exitCode, stdout, stderr,
  timedOut, durationMs }`. Per call it spins up a **fresh, disposable**
  container, clones the repo inside it, applies the diff if given, runs
  the test command under a hard timeout, captures output, and destroys
  the container — no state persists between calls. `/var/run/docker.sock`
  is mounted **only** into `sandbox-runner` itself (via `dockerode`),
  never into the containers it spawns.
- **Verified security posture on a live ephemeral container** (via
  `docker inspect` while one was still running mid-test): `Mounts: []`
  (no docker.sock, no bind mounts of any kind), `Privileged: false`,
  `NetworkMode: sandbox-net` (never `assistant-net` — no route to
  postgres/n8n/ollama/Honcho), `User: node` (non-root, baked into the
  custom `sandbox-node-test` base image at
  `sandbox-runner/base-images/node/Dockerfile` — `node:22-alpine` doesn't
  include `git`, which the ephemeral container needs to clone; installing
  it at image-build time as root means the container itself never needs
  root or package-install capability), plus `Memory`/`PidsLimit` caps.
  Containers are confirmed gone (`docker ps -a`) after every call,
  including the timeout path.
- **Verified real pass/fail detection, not a rubber stamp**: tested
  against a disposable fixture repo (one commit with a passing test, one
  with a deliberately failing assertion) served over the `git://` protocol
  from a throwaway `git daemon` container on `sandbox-net` — no GitHub
  needed for this proof. The passing commit returned `exitCode: 0` with
  the real test output; the failing one returned `exitCode: 1` with the
  actual assertion failure (`2 !== 3`, full stack trace) in `stdout`.

**`coding_task_pipeline` (n8n workflow) — Phase 2 built and verified
end-to-end for real**, a smaller role set than the eventual design
(Planner → Coder → sandbox → update row; no Test-writer/Reviewer/retry
loop yet):

```
Webhook (onReceived) -> Prepare Row -> Insert Row (coding_proposals, status=running)
  -> Planner (Ollama, qwen3:8b, format schema) -> plan text
  -> Fetch File Context (sandbox-runner /execute, testCommand = a `cat`-the-source-files
     command, no patch — a read, not a test) -> real current file contents
  -> Coder (Ollama, qwen2.5-coder:7b) -> unified diff
  -> Parse Coder Output (Code: two defensive normalizations, see below)
  -> Sandbox Execute (sandbox-runner /execute, now with the real patch + testCommand)
  -> Update Row (status=proposed if exitCode 0 else needs_review_failed, diff, test_output)
```

New Data Table **`coding_proposals`** (created directly via SQL, mirroring
n8n's own DDL exactly — see gotcha below for how): `task_description`,
`target_repo_url`, `target_ref`, `status`, `attempt_count`, `diff`,
`test_output`, `reviewer_verdict`, `reviewer_reason` (unused until the
Reviewer role exists), `pr_url` (unused until real-PR mode exists).

**Three real bugs found and fixed via actual end-to-end runs against a
disposable fixture repo** (a real bug in `math.js`, a real failing test,
served over `git://` from a throwaway daemon container — same technique as
the sandbox-runner proof, no GitHub needed):

1. **The mid-graph "Respond to Webhook" pattern doesn't work** — this was
   flagged as unproven in the original plan, and empirically it isn't:
   with `Insert Row` fanning out to both a `Respond to Webhook` node and
   the rest of the pipeline in parallel, the HTTP response still took the
   *entire* execution's wall-clock time (~22s) to arrive, not the instant
   the response node itself ran. The actual mechanism for "ack
   immediately, keep working in the background" is the Webhook trigger's
   own `responseMode: "onReceived"` ("Immediately" in the UI) — it
   responds as soon as the *trigger* fires, before any downstream node
   runs at all, confirmed at ~0.1s response time regardless of how long
   the rest of the workflow takes. Trade-off: the immediate response can't
   include anything computed later (like the inserted row's generated
   `id`) since nothing has executed yet when it's sent.
2. **The Coder produced a plausible-looking but entirely hallucinated
   diff** on the first real run — invented variable names and logic that
   didn't match the actual (much simpler) bug, because nothing in the
   pipeline ever showed it the real file contents; it only ever saw the
   task description text. Fixed by adding the `Fetch File Context` step,
   which cleverly needs no new `sandbox-runner` capability — it's the same
   `/execute` endpoint, just given a `cat`-the-source-files command
   instead of a test command, reusing the "clone → run a command → return
   stdout" mechanism for a read instead of a test.
3. **The Coder's diffs weren't reliably byte-perfect unified diffs**, even
   after fixing #2 and even with a worked example (byte-verified correct,
   including the required leading space on context lines) in the system
   prompt — two distinct, real formatting mistakes were observed across
   runs: the `---`/`+++` header lines run together with no newline between
   them, and a hunk's context line missing its required leading space
   marker. Prompt compliance alone wasn't trusted to prevent either (same
   lesson as `skill_gap_scanner`'s kebab-case normalization) — fixed with
   two things: (a) switched the sandbox's patch application from `git
   apply` to `patch -p1 --fuzz=3 --no-backup-if-mismatch` (installed via
   `apk add patch` in the base image), which tolerates imperfect diffs via
   context-based fuzzy matching where `git apply` is strictly byte-exact;
   (b) `Parse Coder Output` additionally repairs both specific malformations
   deterministically before the diff is ever sent to the sandbox.

**Verified end-to-end after all three fixes**: a real run against the
fixture repo produced a diff that correctly fixed the actual bug
(`return n + n - 1` → `return n * 2`), applied cleanly, and the
previously-failing test passed (`exit code: 0`, `# pass 1`) — row status
`proposed`.

### Phase 3 — Test Writer, and a full rethink of how diffs are built

Added **Test Writer** (`qwen3:8b`, separate call from Coder — a model
shouldn't grade its own tests) between `Parse Coder Output` and
`Combine Diffs`. It sees the same file context Coder saw, plus Coder's
diff, and writes its own diff adding test coverage; the two diffs
concatenate into one combined patch before hitting the sandbox (`patch`
handles a multi-file blob in one pass fine).

**This surfaced a much deeper problem than Test Writer itself**: trusting
the model to write the *entire* diff — including the `---`/`+++` header
— turned out to fail in every distinct way a header can fail, across
real runs: concatenated onto one line, wrong line counts, header omitted
entirely, and (Test Writer specifically) confidently claiming an existing
file was brand new. Patching each pattern as it appeared was chasing an
open-ended list. **Fixed by no longer trusting the model for headers at
all**: the schema now asks for `{file, diff}` as separate fields — `file`
a plain path, `diff` *hunk content only*, starting at `@@`. The `---`/`+++`
header is always built deterministically in code from `file`. The model
is only trusted for the one thing it's actually needed for (the hunk
body), where remaining repairs still apply: stray reasoning-token lines
stripped, missing context-line leading spaces added, and — the
consistently real, universal weak point — **the `@@` header's line
*counts* recomputed from what's actually in the hunk body**, trusting only
the model's start-line numbers. A model can get every line of a hunk
semantically right and still miscount the total by one; `patch` rejects
that outright, and no amount of prompting reliably fixed it, so counting
programmatically is the fix.

**Two more real bugs found via this refactor, both instructive**:
- The count-recompute logic itself had a bug: `split('\n')` on a
  diff ending in a real newline produces a trailing empty-string element,
  which the counting loop's "unchanged context line" branch counted as a
  phantom extra line — inflating an *already-correct* `3,3` count to
  `4,4` and actively breaking output that started right. Fixed by
  excluding a trailing empty split-artifact from the count.
- The "Test Writer assumed a new file" repair was applied unconditionally
  to every existing-file case, even when the model had already written a
  perfectly valid hunk with real context/removed lines — discarding good
  output and replacing it with a stripped-down append that only
  coincidentally still worked sometimes. Fixed by only rebuilding when the
  hunk body is *exclusively* additions (the actual "assumed brand new"
  shape); a hunk that already has context/removed lines just gets the
  standard header.

**Verified across two batches of 5 real runs each** (10 total, not a
single lucky pass): the implementation-fix path was reliable throughout.
Test Writer's bonus test-coverage addition succeeded some of the time and
otherwise **failed safely** — either a clean no-op (no `@@` header
produced → treated as empty, nothing sent to the sandbox) or a patch
`patch` itself refused to apply — never silently corrupting the repo.
**One exception surfaced late, and it's instructive**: a run where the
Coder's own hunk was internally inconsistent — it removed the function
declaration line but never re-added it, producing a real syntax error
(`Illegal return statement`). This isn't a formatting bug and no
deterministic repair can fix it; it's a genuine reasoning error in the
model's diff content. It was still caught correctly (non-zero exit code,
the actual syntax error visible in `test_output`, row marked
`needs_review_failed`) rather than silently passing — which is exactly
the gap **Phase 4's Reviewer + retry loop** exists to close: catch cases
like this and give the Coder another attempt with concrete feedback,
rather than requiring every run to succeed on the first try.

### Phase 4 — Reviewer and the capped retry loop

Added **Reviewer** (`qwen3:8b`, separate call from both Coder and Test
Writer — same self-grading concern) after `Sandbox Execute`: given the
task, the combined diff, and the actual sandbox result, it decides
`approve` / `retry` / `give_up` with a reason, and — for `retry` —
specific feedback for the Coder. `Parse Reviewer Output` carries forward
everything `Update Row` needs (sandbox result, combined diff, attempt
count) from *this iteration's* direct upstream nodes, rather than having
`Update Row` reach back across the loop itself, since how cross-iteration
node references behave was untested.

**The retry loop itself** — capped at 3 attempts — is a real in-graph
cycle: `Should Retry?`'s TRUE branch connects back to a new node, `Build
Coder Prompt` (extracted out of Coder's inline expression specifically so
"is this a retry" can be a real try/catch — referencing a node via
`$('Name')` that hasn't executed yet in the current execution needs safe
handling, which a bare expression can't do). No workflow in this project
had a cycle before this, so — same "verify, don't assume" approach as
everything else here — it was proven empirically rather than trusted on
the strength of the design alone.

**Verified with real runs, both exit paths**: one run finished in a
single attempt (`attempt_count: 1`, `reviewer_verdict: approve`, status
`proposed`) — the early-exit path. Three separate runs reached the
3-attempt cap (`attempt_count: 3`, `reviewer_verdict: retry` even on the
final attempt) and correctly stopped rather than looping forever, landing
on `needs_review_failed` — the cap-enforcement path. Cross-iteration
state came through correctly in every case (attempt counts incremented
properly, Reviewer's feedback on iteration N actually referenced
iteration N's real diff/output, not a stale one) — the loop mechanism
itself is sound.

**One honest, real nuance worth noting**: the Reviewer isn't perfectly
consistent about how strictly it weighs "the core fix works" against "the
task also asked for test coverage and that didn't fully land." Across
these same runs, one attempt was approved after a single try even though
Test Writer's coverage never actually applied (only the original test
ran) — while three others kept retrying for exactly that same shortfall
until hitting the cap. Both are defensible readings of an ambiguous
priority call, not a bug — but it's a real, observed source of variance
worth knowing about rather than assuming the Reviewer applies one
consistent bar.

### Phase 5 — real PR-opening via `sandbox-runner`

Added `sandbox-runner`'s `/propose-pr` endpoint and wired it into the
workflow: when `Should Retry?` exits via `approve` and `Sandbox
Execute`'s `exitCode == 0` and `target_repo_url` contains `github.com`,
`Build PR Request` builds a branch name/commit message/PR title from the
task, `Propose PR` calls `/propose-pr`, and `Merge PR Result`/`Update Row`
record the resulting `pr_url` (or `prError`) on the `coding_proposals`
row. `Should Open PR?`'s `exitCode == 0` check is a hard backstop
independent of the Reviewer's verdict — see below for why that mattered
in practice, not just in theory.

**Security posture, deliberately**: `GITHUB_TOKEN` (a fine-grained PAT,
scoped to `Contents` + `Pull requests` read/write on specific repos only)
is set **only** on `sandbox-runner`, never on `n8n` — n8n persists every
workflow execution's full node inputs/outputs in Postgres in plaintext,
so a token flowing through a workflow's JSON body would sit there
indefinitely. The workflow only ever asks "push and open a PR"; only
`sandbox-runner` ever sees the token, for exactly the duration of one
push. Both `executor.ts`'s push path and its git-clone-for-testing path
scrub the token-embedded URL out of any stdout/stderr they return,
since git's own error messages can echo a failing remote URL back
verbatim.

**Verified in three stages, each surfacing a real bug the previous stage
couldn't have caught:**

1. **Isolated `/propose-pr` call** (bypassing the workflow entirely):
   pushed a branch and opened a real PR
   (`github.com/jabraham05/smart-assistant/pull/1`), confirmed via `gh
   api`, then closed/deleted it — proved the push+PR mechanism itself
   works.
2. **First full-pipeline run against the real, private
   `smart-assistant` repo** (a trivial, safe task: add one explanatory
   comment to `sandbox-runner/src/config.ts`) failed at the clone step:
   `runInSandbox`'s test-execution clone had never been taught to use
   the token, only the push path had — so it couldn't even clone a
   private repo to test against. **Fixed**: `runInSandbox` now also
   builds an authenticated clone URL for `github.com` http(s) targets
   when a token is configured (`maybeAuthenticateCloneUrl`), leaving
   non-GitHub/`git://` URLs untouched.
3. **Second full-pipeline run**, post-fix, cloned successfully but
   surfaced a more fundamental gap: the Coder's diff didn't match the
   real file's actual content and `patch` silently failed to apply —
   yet the script only *logged* `PATCH_APPLY_EXIT_CODE`, then ran the
   test command regardless. `npm run build` then passed against the
   **unmodified original file**, and the Reviewer approved, unable to
   tell a vacuous pass from a real one from the exit code alone. Ground
   truth (`git diff origin/main origin/<branch>`) confirmed the pushed
   branch was byte-identical to `main` — GitHub's own "no commits
   between" 422 on PR creation was the only thing that caught it, not
   anything in this pipeline's own design. **Fixed**: both `RUN_SCRIPT`
   and `PUSH_SCRIPT` now hard-abort (distinctive exit code `97`) the
   moment `patch` returns non-zero, rather than falling through to
   `eval "$TEST_COMMAND"` or `git commit`/`git push` against an
   unchanged tree.
4. **Third full-pipeline run**, post-fix: attempt 1 hit the new
   hard-abort (bad patch, forced a real `retry`, not a rubber-stamped
   pass), the Reviewer correctly sent it back, attempt 2 produced a
   valid diff, and a real PR
   (`github.com/jabraham05/smart-assistant/pull/2`) was opened —
   verified via `gh pr diff`: exactly one line added, the correct
   comment, `mergeable: true`. Closed/deleted afterward, same as stage 1.

**Known remaining nuance, not yet fixed**: the Reviewer can still
rationalize a genuine `PATCH_APPLY_EXIT_CODE` failure as "a formatting
issue, not a problem with the code" when *some* hunk in a multi-hunk
diff happens to apply — the hard-abort above closes the worst case (a
fully vacuous pass) but doesn't stop the Reviewer from being talked into
a bad excuse by its own reasoning. The `exitCode == 0` gate on PR-opening
is the actual backstop here, by design independent of what the Reviewer
says — this is exactly why that gate exists as a separate condition
rather than trusting `reviewer_verdict` alone.

**Not yet built** (unchanged from the original plan, still real gaps):
base-image auto-detection (every task still assumes Node/JavaScript via
the one hardcoded `sandbox-node-test` image) and multi-file/new-file
support (Coder still only targets a single existing file per task).

### Phase 6 — triggers: `code_task` and `scripts/start-coding-task.mjs`

Both trigger paths from the original plan are built. **Explicit/manual**
(the one to actually rely on): `scripts/start-coding-task.mjs <repoUrl>
<task...> [--ref=<branch>] [--test-command="..."]`, mirroring
`scripts/chat.mjs`'s role as a reference client — POSTs directly to the
webhook, needs `N8N_CODING_TASK_WEBHOOK_URL` (host-reachable form, kept
separate from `skills-mcp`'s internal `CODING_TASK_WEBHOOK_URL`, same
split as `N8N_CHAT_WEBHOOK_URL` vs. `chat-ui`'s internal
`N8N_WEBHOOK_URL`). **Reactive**: `code_task`, `skills-mcp`'s 5th tool
(`skills-mcp/src/tools/code-task.ts` + `lib/coding-workflow.ts`, mirroring
`skill-propose.ts`/`skills-workflow.ts` exactly) — fire-and-forget POST to
the same webhook, immediate reply once it's confirmed sent. Both verified
directly: called `code_task` over the raw MCP protocol and via the script,
confirmed a real `coding_proposals` row landed each time with the right
task/repo/ref.

Optional like the calendar tools — omitting `CODING_TASK_WEBHOOK_URL`
returns a clear "not configured" error rather than crashing the server.

**2026-07-27 — real chat-triggered run surfaced a genuine `code_task`
gap.** Asked Amy directly to fix something in this repo's own
`sandbox-runner/src/config.ts` (a TypeScript file). `code_task`'s
zod schema had no `contextCommand` parameter at all — every
chat-triggered task silently fell back to `Prepare Row`'s default
(`find . -maxdepth 2 -name "*.js"`), which only matches `.js` files. The
Coder got zero real content for the actual target file and fully
hallucinated a plausible-but-wrong interface shape (wrong field names,
an invented comment) — `patch` correctly rejected it on all 3 attempts
(Phase 5's hard-abort working exactly as designed), landing on
`needs_review_failed`. This was a real, root-cause bug, not model
flakiness: confirmed by diffing the Coder's output against the actual
file content. **Fixed**: `contextCommand` is now a 5th optional
parameter on `code_task`, described clearly enough that a model calling
it knows to override the default for anything beyond a shallow `.js`
file. Positive finding from the same session, worth noting since it
contradicts the "reactive trigger is unreliable" caveat above: the tool
call itself fired correctly and immediately on a direct, explicit
request — the failure was entirely in what happened after, not in
whether the tool got invoked.

**2026-07-27 — session-aware follow-up, closing a false promise Amy
made.** The same chat-triggered test above ended with Amy saying "I'll
notify you the moment the task is complete" — untrue, since nothing
proactive existed. Fixed by threading the originating chat session
through the whole pipeline and posting a real result back into it:

- The MCP Client Tool node's `endpointUrl` in the `Chat` workflow
  changed from a static string to `=http://skills-mcp:3001/mcp?chatSessionId={{
  $('When chat message received').item.json.sessionId }}` — a normal
  n8n node parameter (not a credential), so it supports the same
  expression access to trigger data every other node in that workflow
  already uses. Confirmed by reading `McpClientTool.node.js` inside the
  n8n container first: the node has no built-in way to merge extra
  static parameters into a model-driven tool call, so this had to
  happen at the transport layer instead. `skills-mcp/src/index.ts`'s
  `/mcp` route was already stateless (a fresh `createServer()` per
  request) — reads `req.query.chatSessionId` and threads it through
  `createServer` → `registerCodeTask` → `submitCodingTask`, present only
  when the call actually came from a chat session.
- `coding_proposals` gets a new `origin_session_id` column, set by
  `Prepare Row` from the incoming payload.
- After `Update Row`, a new `Has Origin Session?` IF node gates two
  notify calls on that column being non-empty — CLI-triggered tasks and
  direct MCP calls have no session and take the untouched FALSE branch,
  confirmed via a real CLI-triggered run's execution data (the notify
  nodes genuinely didn't run, not just returned empty).
- **`Notify Chat History`** — a direct `INSERT INTO n8n_chat_histories`
  (session key `origin_session_id + '__Postgres_Chat_Memory'`, same
  table/key format `Fetch Recent History`/`Fix Postgres Memory Row`
  already use). This is what makes Amy's *own next real reply* in that
  session actually aware of the outcome — verified end-to-end: asked
  "hey, any update on that?" with no reference to the task, and she
  correctly reported the real PR URL and outcome, sourced entirely from
  this injected row, not from being told anything.
- **`Notify Honcho`** — same call shape as the `Chat` workflow's own
  message-store node, same Bearer Auth credential. Makes the result
  appear as a real message bubble next time that specific chat-ui
  conversation is reopened (chat-ui reads session history from Honcho,
  not from n8n's internal Postgres memory table).
- Both `onError: continueRegularOutput`, matching every existing Honcho
  call in this codebase — a notify failure must never be mistaken for
  the pipeline itself failing, since the real result already landed
  safely in `Update Row` first.
- **Real bug caught during verification, not just in theory**: the
  first live run showed `Notify Honcho` succeeding but `Notify Chat
  History` failing with "Node does not have any credentials set" — the
  Postgres credential reference (`Fix Postgres Memory Row`'s exact
  `{ postgres: { id, name } }` block) had been copied for the query but
  not attached to the node itself. Fixed, then re-verified clean on both
  a failure-path run and a success-path-with-PR run.
- **What this is and isn't**: session-aware follow-up, not real push. If
  the user isn't back in that specific conversation, nothing pops up —
  the message just waits there, surfaced next time that conversation
  continues (either by reopening it, or by saying anything at all, since
  Amy's own context already includes the outcome by then). True push
  (something appearing while the user is doing something else entirely)
  would need new infrastructure — an SSE/websocket channel to `chat-ui`,
  or an external channel like email/SMS — explicitly out of scope here.

### 2026-07-27 — persistent-container redesign: Planner/Coder/Tester/Reviewer (partially working)

Replaced the one-shot "Coder emits a blind diff" model with a genuinely agentic one: each task gets its own **persistent** container (not destroyed until the task's retry loop actually exits), and a **Coder Agent** and **Tester Agent** — separate `@n8n/n8n-nodes-langchain.agent` nodes — get real shell access to it via two new MCP tools, `code_task_run_command` and `code_task_get_diff`, instead of hallucinating a diff from one pre-fetched file snippet. `Planner` stays a single non-tool-calling Ollama call (deliberately — the container is empty at that point, nothing to explore yet); `Reviewer` now also breaks its verdict down into a structured per-test pass/fail/reasoning array. Retry re-invokes only the Coder Agent in the *same* container (Tester's tests aren't regenerated) — the container is destroyed only once the loop actually exits (approved, gave up, or the attempt cap is hit).

**New in `sandbox-runner`**: `POST /task` (create a long-lived container, clone the repo, return `{containerId, workingDir}`), `POST /task/:id/exec` (run one command, `timeout Ns` wrapping it since dockerode can't kill an individual exec from the host side), `GET /task/:id/diff` (`git add -A -N && git diff` — the `-N`/intent-to-add is what makes brand-new files show up at all), `DELETE /task/:id`. A `setInterval` reaper force-removes any container past an idle timeout (300s default) or hard max lifetime (1800s default) via an in-memory last-activity map — this is a genuinely new resource-leak risk the old one-shot model never had, since every container's entire lifetime used to be exactly one shell script's runtime. `GITHUB_TOKEN` is never read anywhere in this new code path — only the existing `proposePullRequest` (a separate, still-ephemeral, non-agentic container) ever sees it, since the persistent container the model has arbitrary shell access in must never be able to reach it.

**Also added**: `code_task`'s `repoUrl` is now optional — omit it for a from-scratch task with no existing target, which lands in a shared `coding_tasks` repo (one folder per task, named via the same slug+timestamp scheme as branch names) instead of a named project. `code_task_status` (a normal chat-facing tool, unlike the two container-exec tools which are pipeline-internal only) lets a user ask Amy for a progress update mid-task — backed by a new `latest_status` column updated after every phase, and a new `GET /webhook/coding-task-status?sessionId=...` trigger in the same workflow. A new append-only `coding_task_log` Data Table records the plan, each Coder/Tester round's output, the real test run, and the Reviewer's structured verdict — one row per phase per attempt.

**A real bug found via live testing, already fixed**: inserting `Destroy Task Container` between `Should Retry?` and `Should Open PR?` (and `Log Reviewer` between `Parse Reviewer Output` and `Should Retry?`) broke those IF nodes' bare `$json.verdict`/`$json.exitCode` references — they used to work only because the nodes were directly adjacent to `Parse Reviewer Output` and n8n's IF node passes its input through unchanged. Both were silently reading `undefined` (the new intermediate node's own unrelated output) instead of erroring, so `Should Retry?` would never actually retry and `Should Open PR?` would never actually open a PR, regardless of the real verdict. Fixed by making both reference `$('Parse Reviewer Output').item.json...` explicitly. **Lesson: inserting a node between an upstream node and something that reads a bare `$json` from it is a silent, no-error-thrown way to break a condition** — grep for bare `$json.` references before/after restructuring a graph, don't just check that the new node's own inputs/outputs are correct.

**Root cause found and fixed: n8n's MCP Client Tool node silently breaks qwen3:8b's tool-calling once the combined tool name gets too "segmented."** The Coder Agent was producing completely empty output with zero tool calls on every real run, while the identical setup worked fine in isolated throwaway-workflow tests — the kind of discrepancy that looks like non-determinism until you find the one real variable nobody controlled for. It wasn't model choice, `think`, `enableStreaming`, shared-vs-dedicated sub-nodes, static-vs-dynamic `endpointUrl`, one-vs-two agents, prompt length, model-swap timing, or context window size — all individually tested and ruled out.

The actual mechanism: n8n's `@n8n/n8n-nodes-langchain.mcpClientTool` node prefixes every tool it exposes with its own node display name before handing it to the model (e.g. a node named "Task Container Tool" turns `code_task_run_command` into `Task_Container_Tool_code_task_run_command`). Found by literally instrumenting n8n's own `runAgent.js` in the running container to log around the model-invoke call (confirmed the call genuinely resolved with empty output, no thrown error anywhere in the chain) and standing up a disposable logging reverse-proxy between n8n and Ollama (pointing the Ollama Chat Model node's credential at it) to capture the *exact* request/response bytes for a real failing call. Replaying that exact captured request verbatim, varying only the tool name, proved it deterministically: the model burns real generation tokens (`eval_count` in the 20s-30s) but the output never resolves into a `tool_calls` block once the combined, underscore-joined name crosses somewhere around 5-6 segments (`Task_Container_Tool_code_task_run_command` = 8 segments, fails every time; `code_task_run_command` bare = 4 segments, works every time) — this is a real limitation in qwen3:8b's (or Ollama/llama.cpp's) tool-calling grammar for compound function names, not an n8n or MCP bug, and it fails with zero error signal anywhere in the stack (n8n reports `execution.succeeded: true`).

Fixed by shortening the actual registered MCP tool names (`code_task_run_command` → `run_command`, `code_task_get_diff` → `get_diff`, in `skills-mcp/src/tools/`) so there's headroom left for the mandatory node-name prefix — confirmed `Task_Tool_run_command` (4 segments) works reliably. Verified with two full end-to-end runs against the real fixture repo: both approved on the first attempt, both opened real PRs, with genuine non-empty output at every phase (Coder's own `STATUS:` line, Tester's real analysis, a passing `test_run`, a substantive Reviewer verdict). **If a similar "empty output, zero tool calls, no error" symptom ever resurfaces with a different tool/model combination: check the combined (node-name-prefixed) tool name length/segment count first** — it's invisible in the n8n UI and in any per-node config, only visible by capturing the actual bytes sent to the model.

Also worth noting for next time: this project's own already-documented gotcha ("explicitly naming a tool by its internal identifier in a prompt reliably produces empty output from qwen3:8b") is a close cousin of this bug and was independently re-discovered mid-investigation when the Tester Agent's system prompt referenced `code_task_get_diff` by name — removed in favor of describing what to do, not which tool to call.

### 2026-07-28 — deterministic repo fallback, two silent-crash fixes, and a `write_file` tool

A real user report ("it said it started it but I don't see it and now it can't find it") traced back to the Coder Agent hallucinating a fake repo URL (`https://github.com/your-username/simple-guessing-game`) for a from-scratch task instead of correctly omitting `repoUrl`. The deeper problem: `Create Task Container` had no fallback at all — a bad or invented `repoUrl` threw, and that error crashed the *entire n8n execution* before it ever reached `Update Row`/`Has Origin Session?`, leaving the row stuck at `status: running` forever with **no failure ever surfaced to chat**. Decided (per explicit user direction) that the workflow itself, not the model's judgment, should own where a task lands: `repoUrl` is still honored when genuinely given, but `sandbox-runner`'s `createTaskContainer` now tries the primary repo first and falls back to the shared `coding_tasks` landing repo on failure (`attemptCreateTaskContainer` in `sandbox-runner/src/executor.ts`, returning a failure reason instead of throwing; only throws if *both* the requested repo and the fallback fail). The n8n side gained `Container Created?` (IF) → `Build Infra Failure Record` on the failure branch, producing the exact same JSON shape `Merge PR Result`/`No PR` already produce so it plugs straight into the existing `Update Row` node — no changes needed to anything downstream.

Testing the fallback against a genuinely larger task (a full CLI game, not a one-line fixture fix) surfaced the same crash class a second time: the Coder Agent hitting its `maxIterations` cap also throws and kills the whole execution, same stuck-row-no-notification symptom. Fixed with the identical pattern at both agent nodes — `onError: "continueRegularOutput"`, a `Coder Succeeded?`/`Tester Succeeded?` IF node checking `$json.error`, and `Build Coder/Tester Failure Record` nodes matching the same established output shape. Iteration caps also raised (Coder 15→25, Tester 10→15) since the original caps were only ever exercised against tiny fixture tasks.

Also hit: `Prepare Row`'s Code node read `$env.CODING_TASKS_REPO_URL` — n8n blocks `$env` access in Code nodes by default (`N8N_BLOCK_ENV_ACCESS_IN_NODE`), and this was the first real test where that branch actually executed (every prior test supplied a real `repoUrl`, short-circuiting past it). Fixed by hardcoding the (non-sensitive) landing-repo URL directly rather than loosening the instance-wide setting.

With the crash fixed, the actual code-generation failure underneath it became visible: the Coder Agent's only way to write file content was `run_command` (`echo "..." > file`), which breaks the instant the content itself contains a double quote (e.g. `input("Enter your guess (1-100): ")`) — the embedded quote closes the outer `echo "..."` string early and silently produces an empty or truncated file, with no error anywhere. Added a dedicated `write_file` MCP tool (`skills-mcp/src/tools/code-task-write-file.ts`) that takes `filename`/`content` as separate parameters and writes the content as raw bytes over the container exec's own stdin stream (`writeFileInTaskContainer` in `sandbox-runner/src/executor.ts`, new `POST /task/:id/write-file` route) — the content never touches shell parsing at all, so there's nothing to quote. Verified directly against a file containing the exact failing Python snippet: byte-for-byte round-trip, including the embedded quotes. Wired into both `Task Tool`/`Tester Tool`'s `includeTools` (kept short — `write_file`, one segment, well under the node-name-prefix budget documented above) and both agents' system prompts, describing the capability rather than naming the tool identifier (per the gotcha above).

Re-running the same from-scratch task with the fixes above (row 64) surfaced one more real gap: the Coder wrote a correct `guess_game.py` on the first try (confirming `write_file` works end-to-end, not just in isolation), but the Tester Agent then hit its own iteration cap trying to run/verify it — because the shared `sandbox-node-test` base image (`sandbox-runner/base-images/node/Dockerfile`) has no Python interpreter at all, only Node. `Should Open PR?`'s `exitCode == 0` gate correctly kept this from ever reaching a PR, and the failsafe fix correctly surfaced it as a clean `give_up` instead of a crash — but the task genuinely couldn't succeed. Fixed by adding `python3 py3-pip` to the one shared base image (still one image for every task regardless of language — real per-task/per-language image selection is still the "not yet built" gap noted above, this just makes the single shared image cover the common case instead of Node-only).

**A second, more interesting root cause found the same way (row 66):** after Python was available, a re-run again ended in `give_up` on the Tester's iteration cap — but decoding the actual execution data (n8n's execution-data blob is `flatted`-encoded; parsed directly with the `flatted` npm package rather than guessing) showed the Coder Agent's first turn returned completely empty output with **zero tool calls**, confirmed via n8n's own agent tracing (`tool_calls.requested: 0, tool_calls.completed: 0, output: ""`) and cross-checked against n8n's logs — the call genuinely ran for the full 11.6 seconds (not a fast-fail) and happened to land exactly as Ollama was evicting/reloading the qwen3:8b weights for GPU VRAM pressure freed up by the prior Planner call finishing. `Coder Succeeded?` only checked that `$json.error` was empty — a no-op, zero-tool-call response has no `error` field either, so it silently passed through as "success," and the entire implementation burden fell on the Tester (confirmed in its own tool-call trace: it ended up writing *both* `guess_game.py` and `test_guess_game.py` itself, on top of its actual job, and predictably ran out of its 15-iteration budget mid-way through fighting an unrelated pip/PATH issue).

Fixed two ways: (1) `Coder Succeeded?` now also requires non-empty `$json.output`, so a no-op turn is caught as a real failure instead of silently passing through; (2) added a one-shot `Coder Agent Retry` node (same model/tools/system-prompt as `Coder Agent`, plus one sentence noting it's a retry) wired off the failure branch, with its own `Coder Retry Succeeded?` check before falling through to the existing `Build Coder Failure Record`. Deliberately *not* a loop-back-with-counter — an AI Agent node's output completely replaces whatever fields rode in on its input, so a retry counter can't just ride along in `$json`, and n8n's cross-run self-reference semantics for a genuinely looped node weren't worth gambling on without extensive live verification. A dedicated second node guarantees exactly one extra attempt with none of that risk. `Update Status After Coder` also had to change: it hardcoded `$('Coder Agent').item.json.output` to pull the `STATUS:` line, which would keep reading the *original* (empty) Coder Agent's output even when the retry succeeded — switched to `$json.content` (from `Log Coder Round`'s own insert result, confirmed live that a Data Table insert echoes back the exact column values it just wrote) so it correctly reflects whichever agent actually produced the real output.

### 2026-07-30 — architectural rethink: `coding-orchestrator` replaces `coding_task_pipeline`'s state machine

After the fixes above, the pipeline kept hitting *new* failure modes at roughly the same rate fixes landed: n8n's implicit pairedItem lineage silently breaking through an AI Agent node's error branch (`$('Node').item.json` resolving fine on a happy path, then throwing "prompt could not be resolved" the moment the same reference is read after a Coder/Tester retry), a node emitting zero items silently skipping every downstream node (the same class of bug already hit once in the Chat workflow's `Get Active Skills`), and two `httpRequest` nodes (`Coder Agent Retry`, and separately the Chat workflow's own `AI Agent`) missing the `onError: continueRegularOutput` every sibling node had — the exact gap that turned an ordinary max-iterations error into a hard crash with no recovery. Asked directly to rethink the architecture rather than patch the next spot, a full audit of the live workflow (54 nodes, 62 edges) turned up further real gaps: `Tester Succeeded?` only checked for an absent error, not non-empty output (unlike `Coder Succeeded?`); the Tester never received retry feedback the Coder did; give-up paths skipped `Destroy Task Container` entirely (masked only by `sandbox-runner`'s own independent idle-container reaper); and — found live, mid-review — `sandbox-runner`'s per-container 100-command cap colliding with the *new* retry mechanism, since more attempts means far more cumulative tool calls than before.

The pattern across every single one of these: the actual Planner/Coder/Tester/Reviewer logic worked correctly every time it got the chance to run; every failure traced back to n8n's own execution model. `sandbox-runner` already is this project's precedent for "write real code where n8n doesn't fit" — so the pipeline's actual state machine moved there too.

**`coding-orchestrator`** (new service, `coding-orchestrator/`, mirrors `sandbox-runner`'s structure): owns Planner→Coder→Tester→Reviewer→retry as real TypeScript — one real `for` loop instead of three near-duplicate retry branches (`Should Retry?`/`Tester Retry Eligible?`/`Coder Retry Eligible?` all converging on `Build Agent Prompt`'s own recency-picking merge), real `try/catch/finally` guaranteeing container cleanup and origin notification run *every* time regardless of which path failed, and a new `coding_task_log` table recording phase/status/error on every attempt — the direct fix for the biggest cost of today's whole rethink: every bug above required manually decoding n8n's `flatted`-serialized `execution_data` by hand; one `SELECT` should suffice from now on. `agent-loop.ts` reimplements the Coder/Tester tool-calling loop directly against Ollama's native `/api/chat` `tools` API (validated first as a standalone spike — confirmed `qwen3:8b` returns proper `tool_calls` via raw HTTP, not just through n8n's LangChain integration — before committing to the rewrite). New dedicated `coding_tasks` Postgres database (`postgres/init/03-create-coding-tasks-db.sql`, same "won't auto-apply to the existing volume" caveat as `research`'s own init script) replaces the old `codingproposals1`/`codingtasklog01` n8n Data Tables, which are left alone as historical records, not migrated.

`sandbox-runner` gained one real fix along the way: the command-limit cap now throws a typed `CommandLimitExceededError` mapped to HTTP 429 (`sandbox-runner/src/executor.ts`, `index.ts`), so `coding-orchestrator` can treat "ran out of budget" as a distinguishable `resource_limit_reached` outcome instead of string-matching an error message.

n8n's role shrank to a thin proxy (`n8n/workflows/codingorch0001.json`, `coding_task_orchestrator_proxy`): `Webhook (coding-task) -> HTTP Request (proxy to coding-orchestrator:3003/task)` and the equivalent for status. `codingtaskpipe1x` is kept deactivated as a rollback reference rather than deleted. `skills-mcp`'s `code_task`/`code_task_status` tools needed **zero changes** — same webhook URLs, same request/response shapes.

One real n8n internals gotcha hit during cutover: `n8n unpublish:workflow` deactivates a workflow but does **not** clean up its rows in `webhook_entity` — the old workflow's `coding-task`/`coding-task-status` paths stayed registered and blocked the new proxy workflow from claiming them ("The URL path that the 'Webhook' node uses is already taken"), reproducibly across multiple restarts, until those two rows were deleted directly (`DELETE FROM webhook_entity WHERE "workflowId"='codingtaskpipe1x'`).

**Verified live end-to-end**, in order: a standalone spike confirmed Ollama tool-calling works via raw HTTP; a task run directly against `coding-orchestrator` (bypassing n8n) completed successfully first try with a clean structured log and no leaked container; a second run exercised *both* the Reviewer-rejection retry and a genuine Coder-round failure retry in the same run (unified through the one shared loop), still correctly cleaned up its container and notified the origin session on the eventual honest give-up; the full webhook path (`skills-mcp` → n8n proxy → `coding-orchestrator`) round-tripped correctly for both submit and status; and a final clean run went all the way through two real attempts to `approve` and opened a genuine PR (`github.com/jabraham05/coding_tasks/pull/4`), with the origin-session notify message landing correctly. One tuning fix along the way: the default Ollama call timeout (120s) turned out too tight for real GPU contention when testing several tasks concurrently (a `qwen3:8b`/`qwen3:14b` model swap under load can plausibly exceed that) — raised to 240s; even while that was mistuned, the resulting abort was caught cleanly by the outer `try/catch/finally` and reported honestly rather than crashing silently, which was the entire point of the rewrite.

### 2026-09-03 — trimming `agent-loop.ts`'s message history to the model's actual context budget

`agent-loop.ts` (the Coder/Tester tool-calling loop from the rewrite above) accumulates every tool call and result into one growing message array across up to 25 iterations — exactly the mechanism `ollama.ts`'s `DEFAULT_NUM_CTX` (16384) comment already flags as a real, observed contributor to empty-output failures once the effective context runs out mid-loop. Two fixes, both deliberately conservative (no tokenizer available for an arbitrary Ollama model, so chars-per-token is estimated at a generous 4:1):

- `truncateToolResult` caps any single tool result (a full test run, a `cat` of a large file) at 4000 chars before it ever enters history, keeping the head and tail rather than just the head — the command that ran is obvious from the start, the actual error is usually at the end.
- `trimHistoryToBudget` runs once per iteration and, once the running history threatens to exceed `numCtx`, drops the oldest assistant/tool-result exchanges (never the system prompt or the original task, `messages[0]`/`messages[1]`) and replaces them with a one-line marker noting how many were omitted — the work already applied in the container isn't repeated, just no longer shown.

`numCtx` is now an explicit `AgentLoopOptions` field (defaulting to `ollama.ts`'s own now-exported `DEFAULT_NUM_CTX`) so the trim threshold can't silently drift out of sync with whatever context window is actually requested from Ollama.

### 2026-09-04 — replacing `PATCH_B64` with a tar-based file write, for diffs too large for `ARG_MAX`

Both of `sandbox-runner`'s scripted container paths (`RUN_SCRIPT`'s test execution, `PUSH_SCRIPT`'s PR-proposal push) used to pass the unified diff into the container as a base64-encoded environment variable (`PATCH_B64`), decoded back to a file inside the script. That has no size limit that's actually safe — a real diff touching a generated file like `package-lock.json` routinely runs to hundreds of KB, well past the kernel's `ARG_MAX` for a single `exec`. Replaced with `buildSingleFileTar` — a minimal single-file POSIX ustar archive written into the (not-yet-started) container via dockerode's `putArchive` (the `docker cp` equivalent), the same "bypass shell/exec argument parsing entirely" approach the `write_file` tool above already established. `runEphemeralContainer` now takes an optional `files` list, written before `container.start()`; both `RUN_SCRIPT` and `PUSH_SCRIPT` simplified to just check `[ -f /tmp/patch.diff ]` instead of decoding an env var.

## Smart-mirror dashboard (Raspberry Pi)

A second physical client: a Raspberry Pi with a display, running its own
separate app (`smartmirror-app`, its own git repo on the Pi itself at
`/home/johna/smartmirror-app`, not part of this repo — reached via SSH,
not checked in here). Amy is now that dashboard's actual data source and
controller, not just a chat backend — she decides what widgets show, what
data they display, and can rearrange them on request.

```
dashboard_state (n8n workflow, webhook + Schedule Trigger)
  Webhook: POST /dashboard-state, called by the Pi at server startup
  Schedule Trigger: every 3 hours, pushes to the Pi instead of responding
        |
        v
  Get Persona -> Catalog Ready (Code: GET Pi's /api/widgets/catalog,
        falls back to a hardcoded default catalog if the Pi is briefly
        unreachable) -> Fetch Dashboard Data (skills-mcp
        /internal/dashboard-data, no LLM) -> Decide Widgets (Ollama,
        format-constrained JSON: which catalog types to show, in what
        order, height 1 or 2) -> Parse Decision (deterministic clamp) ->
        Build Row -> Update Dashboard State (Data Table, upsert) ->
        [Webhook path: Respond to Webhook] / [Schedule path: POST
        Pi's /api/assistant/apply]

dashboard_control (n8n workflow, webhook only)
  POST /dashboard-control {action, type?, position?, h?}
        |
        v
  Get Current State (Data Table) -> Apply Change (Code: deterministic,
        no LLM — get_layout/show/hide/move/resize) -> Fetch Fresh Data
        (skills-mcp, for a 'show' bringing back a type with stale data) ->
        Merge Fresh Data -> Save State (Data Table upsert) -> Push To Pi
        (POST /api/assistant/apply, onError continue — a briefly
        unreachable Pi shouldn't fail the tool call) -> Respond to Webhook
```

- **Widgets are a self-describing catalog Amy chooses from, not a
  hardcoded fixed set.** The Pi exposes `GET /api/widgets/catalog`
  (`server/src/core/widgetCatalog.ts`, duplicated from
  `src/widgets/registry.ts`'s `description` field — separate frontend/
  server builds, no shared package) listing the widget types it knows how
  to render and what each is for. `dashboard_state` fetches this and
  decides which types are worth showing right now — a type simply absent
  from the decision doesn't render, no separate visibility flag. The
  `assistant` widget itself is deliberately **not** in the catalog — it's
  always pinned (or, as of the styling cleanup below, removed from the
  layout entirely), not something Amy chooses to show/hide.
- **Layout is a centered row, not a 2D grid — this was a real design
  change mid-build.** The first version used a 4-column grid with `x/y/w/h`
  per widget. The user asked for the widgets centered as a group with
  "enlarge just makes it taller" — which meant dropping 2D positioning
  entirely: widgets are now always the same fixed width, array order is
  left-to-right display order, and only `h` (1 or 2) varies. This
  simplified the schema end-to-end (n8n's decision prompt, the
  `dashboard_control` tool's `move`/`resize` actions, the Pi's CSS) from
  `{type, x, y, w, h}` down to just `{type, h}`. `mirror.css`'s `.modules`
  is `display: flex; flex-wrap: wrap; justify-content: center` instead of
  a CSS grid; each widget's wrapper gets an inline `minHeight` (not a
  fixed `height` — see the gotcha below) computed from `h`.
- **New skills-mcp routes, no LLM involved**: `GET /internal/dashboard-data`
  (`skills-mcp/src/routes/dashboard-data.ts`) normalizes weather (incl.
  today's high/low)/calendar/Spotify (incl. progress/duration) into the
  Pi's exact existing types, each source fetched/caught independently so
  one failing never blanks the others; `POST /internal/spotify-action`
  (`skills-mcp/src/routes/spotify-action.ts`) does play/pause/next/
  previous for the Pi's transport buttons without a model round-trip. Both
  reuse the same `lib/open-meteo.ts`/`lib/google-calendar.ts`/
  `lib/spotify.ts` the MCP tools already call.
- **New MCP tool `dashboard_control`** (`skills-mcp/src/tools/dashboard-control.ts` +
  `lib/dashboard-control.ts`) — `get_layout`/`show`/`hide`/`move`/`resize`,
  wired into the Chat workflow's classifier (`dashboard` category added to
  `Classify Relevant Tool Groups` + `Expand Groups To Tools`'s `GROUPS`
  map). `move` takes a `position` (index in display order); `resize` takes
  only `h` (1 or 2) — no `x`/`y`/`w` params exist anymore, matching the
  centered-row layout above.
- **The Pi can only reach n8n, never skills-mcp directly** — skills-mcp
  has no published port by design (see architecture section above), and
  the Pi is a separate physical machine on the LAN, not on `assistant-net`.
  This is why `dashboard_state`/`dashboard_control` exist as n8n workflows
  at all rather than the Pi calling skills-mcp's routes directly, and why
  Spotify's play/pause/skip buttons route through a new `spotify_action`
  n8n webhook (`POST /webhook/spotify-action`) forwarding to skills-mcp's
  `/internal/spotify-action`, instead of hitting it directly.
- **Voice**: `POST /api/assistant/voice-command` on the Pi
  (`server/src/integrations/assistant/service.ts`'s `sendVoiceCommandToAmy`)
  reuses the *existing* Chat webhook (same one `chat-ui` talks to) with a
  fixed `sessionId: "pi-voice"`, rather than a separate assistant pipeline
  — the physical device gets its own continuous multi-turn Honcho/Postgres
  memory, distinct from any browser session. Parses the same NDJSON stream
  `chat-ui`'s `useChat.ts` does (ported to Node), then speaks the reply via
  the already-working TTS path (`synthesizeWav` + `tts:speak` WS event,
  called directly in-process rather than looping back through HTTP to
  `/tts/announce`). **The actual wake-word/STT daemon
  (`voice-daemon/listener.py`, openWakeWord + a vendored whisper.cpp) is
  staged but untested** — no microphone is attached to the Pi yet. Text-in
  → Chat webhook → TTS-out is fully verified end-to-end; only the
  mic-to-text leg is unbuilt hardware-wise.
- **Deliberately not using the Wyoming protocol** (unlike the originally
  considered Home Assistant Voice pattern) — Wyoming's value is
  standardizing a network protocol across *separate* satellite devices,
  which doesn't apply to a single Pi where TTS-out already works via a
  simpler "vendor a binary, spawn it directly from Node" pattern
  (`server/src/integrations/tts/service.ts`). `voice-daemon/listener.py`
  mirrors that same approach for STT instead. Revisit only if multi-room
  satellites are ever wanted.
- **Widget styling cleanup** (user feedback after first seeing it running):
  weather now leads with a large hero temperature + condition + high/low
  (data that was already being fetched but not surfaced); calendar caps at
  2 events with truncated titles on their own line; Spotify became an
  actual mini player (album art thumbnail, progress bar, transport
  controls) instead of plain text; the `assistant` widget was dropped from
  the layout entirely — it only ever showed Amy's internal reasoning text
  ("Weather is relevant because..."), not anything meant for a user to
  read.
- **Latency investigation** (user-reported, both chat/voice response time
  and dashboard updates felt slow):
  - **qwen3:8b defaults to thinking-mode ON even when a call never
    requests it** — confirmed by direct testing: an identical call's
    generation time dropped from ~2.9s to ~0.09s with `think: false` set
    explicitly. Fixed on `Classify Relevant Tool Groups`, the main `AI
    Agent`'s `Ollama Chat Model` node (which had `think: true` set
    *explicitly*, forcing the cost), and `Ollama Direct Fallback`.
  - **The GPU idles down to its lowest power state (P8) between requests**
    on this machine (a consumer GeForce card, not a datacenter GPU) —
    `nvidia-smi --query-gpu=pstate,clocks.sm` showed P8 / 315MHz vs. a
    3090MHz max. The first request after any idle period pays a 3-10s
    "wake up" tax; subsequent requests are fast (~0.3s) until it idles
    down again. `OLLAMA_KEEP_ALIVE=-1` keeps the *model* resident in VRAM
    but doesn't stop the GPU itself from clocking down — a separate
    concern. Fix (user's choice, not yet applied by default): lock a
    higher minimum clock, e.g. `nvidia-smi -lgc 1500,3090` (needs an
    Administrator shell on Windows; doesn't persist across reboots without
    a scheduled task) — trades constant higher power draw/heat for
    eliminating the wake-up delay.
  - **Tried and reverted: parallelizing the Chat workflow's independent
    Honcho/Data Table lookups** (`Ensure Session Exists`/
    `Set User Observe Config`, `Get User Card`, `Get User Card For Amy`,
    `Get Active Skills`/`Format Skills Catalog` — none actually depend on
    each other's output, only on the trigger). Restructured into parallel
    branches synchronized by a chain of `Merge` nodes (`chooseBranch`
    mode), deployed, and measured via actual node start/end timestamps in
    the execution data: **zero overlap, zero speedup**. n8n runs every
    node in a single execution one at a time regardless of branch
    topology in the graph — "parallel" branches don't run concurrently in
    wall-clock time unless you hand-roll real concurrency (e.g. a Code
    node doing `Promise.all()` over raw `fetch()` calls, which runs into
    Honcho's API key living in an n8n credential rather than something a
    Code node can read directly — not pursued given the modest ~500ms
    upside). Reverted the restructuring to avoid the added complexity for
    no benefit.
  - **Real, low-risk win applied**: the Pi's voice-command handler now
    stops reading the Chat webhook's NDJSON stream as soon as the `AI
    Agent` node's own `"end"` event arrives, instead of waiting for the
    whole HTTP connection to close. The workflow keeps running after the
    visible reply (garbage-output check, then the Honcho/Postgres memory
    write) — confirmed via execution timing to add ~900ms that a voice
    reply has no reason to wait on before speaking.

## Discord bridge

Lets the user talk to Amy from their phone over Discord DM, from anywhere —
not just on the LAN like `chat-ui`. `discord-bot/` (Node/TS, `discord.js`)
is a fourth thin client of the same `Chat` webhook `chat-ui`/`scripts/chat.mjs`
talk to, following the exact NDJSON-streaming parse `chat.mjs` already uses
(only `"item"` events from the `AI Agent` node carry reply text).

**Deliberately not the "expose n8n's webhook publicly + n8n's Discord
Trigger node" approach.** That path (Discord's Interactions Endpoint) needs
a real internet-reachable HTTPS URL Discord can POST to, with Ed25519
signature verification — the stack's `WEBHOOK_URL` is `http://localhost:5678/`
by design, and standing up a tunnel/reverse-proxy just for this would be new
attack surface for a project whose default is "zero external exposure"
(Honcho is the one deliberate exception, and even that's an outbound HTTPS
call, never inbound). Discord bots instead connect *outbound* to Discord's
gateway over a websocket (the same way `discord.js` clients normally work),
so `discord-bot` needs no published port and no public URL at all — it's a
`docker-compose` service on `assistant-net` only, reaching `n8n` internally
exactly like `chat-ui` does.

**Scoped to DMs from one allowlisted user, nothing else.** `discord-bot`
ignores every message that isn't a DM, and every DM from a user ID other
than `DISCORD_ALLOWED_USER_ID` — there's no reason for this bot to ever
respond in a server channel or to a stranger who finds it. Session
continuity uses a fixed `discord-<userId>` sessionId (same pattern as the
CLI client's `.chat-session-id` file and the Pi's fixed `"pi-voice"`
session), so Honcho/Postgres memory persists across app restarts and
separate phone sessions.

Setup requires a one-time Discord Developer Portal app + bot (token into
`DISCORD_BOT_TOKEN`, "Message Content Intent" enabled under Privileged
Gateway Intents, invited to any one server the user is also in — Discord
only allows DMing a bot you share a server with, the actual conversation
still happens in the DM afterward) and the user's own Discord user ID
(`DISCORD_ALLOWED_USER_ID`, via Developer Mode > right-click > Copy User
ID) — full steps in `.env.example`.

Typing indicator is kept alive by re-sending `sendTyping()` every 8s while
waiting on a reply (Discord's own indicator only lasts ~10s server-side).
Replies over Discord's 2000-character message cap are split on the nearest
newline/space rather than hard-cut mid-word (`chunkForDiscord` in
`discord-bot/src/chat-client.ts`).

## Research workflow (topic research, markdown synthesis, RAG recall)

**2026-07-29 — added because Amy had no way to build persistent knowledge.**
`web_search` (above) is a one-shot lookup with no memory; Honcho only models
the user, not arbitrary subject-matter knowledge. This closes that gap: a
background pipeline that researches a topic across multiple web searches,
synthesizes a detailed markdown document, and stores it so it's recallable
later via semantic search (RAG) — from any conversation, not just the one
that started the research.

**Three trigger paths**, all wired to the same `research_pipeline` n8n
workflow's submit webhook: an explicit ask ("research X and remember it"),
Amy's own proactive judgment mid-conversation (the `research_task` tool's
description doesn't restrict it to explicit requests), and fully
autonomously from `skill_gap_scanner`'s nightly scan — its `Ollama Reasoning`
node now tags each proposal with a structured `gap_type`
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
`coding_task_pipeline`'s proven three-webhook shape: `research-task`
(POST, fire-and-forget submit — a Research Agent uses `web_search`
repeatedly across different angles, ends its reply with a `SOURCES:` block
that's parsed out deterministically rather than trusted from prose, then a
separate non-agentic Ollama call synthesizes the findings into a titled
markdown document), `research-task-status` (GET, synchronous poll, same
pattern as `code_task_status`), and a new third one, `research-search`
(POST, synchronous RAG query — embeds the query via `nomic-embed-text`,
does a pgvector cosine-similarity search over `research_chunks`, returns the
top matches with their parent document's title/URLs). A hard failure mid-run
routes to marking the row `status: 'failed'` rather than leaving it stuck
at `running` forever — the coding-agent pipeline hit exactly that failure
mode once already (see its section above).

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

## Directory layout

- `docker-compose.yml` — the whole stack.
- `postgres/init/` — one-time DB init scripts (creates the `n8n` database
  and, as of `02-create-research-db.sql`, the `research` database + pgvector
  schema for the Research workflow below; runs once against an empty volume
  only — see that section for the manual-migration command needed on an
  already-existing volume like this project's).
- `n8n/workflows/` — exported workflow JSON, for history/diffing. Edit
  workflows in the n8n UI, then run `scripts/export-n8n-workflows.sh`.
- `chat-ui/` — Next.js custom web chat client, wired into
  `docker-compose.yml` (builds from `chat-ui/Dockerfile`, serves on
  `:3000`). Proxies chat through the n8n webhook and reads session
  list/history from Honcho.
- `discord-bot/` — Discord DM bridge, another thin client of the same Chat
  webhook (see "Discord bridge" below).
- `skills-mcp/` — MCP server hosting agent-callable tools
  (`memory_recall`, `weather_get`, `skill_propose`, `calendar_event`,
  `code_task`, `spotify_control`, `dashboard_control`, `web_search`,
  `research_task`, `research_task_status`, `research_search`, `goal_manage`,
  `calculate`),
  plus internal (non-MCP) routes `/internal/dashboard-data` and
  `/internal/spotify-action` (see "Smart-mirror dashboard" above), wired
  into `docker-compose.yml` (builds from `skills-mcp/Dockerfile`,
  internal-only, no published port). n8n's `Chat` workflow reaches it via an
  `MCP Client Tool` node.
- `event-bus/` — event ingestion, deterministic classification, and
  deterministic goal-matching (see "Event bus + goals" above); its own
  dedicated `events` Postgres database, internal-only, no published port.
- `sandbox-runner/` — Docker-outside-of-Docker sandbox for the coding-agent
  pipeline (see the "Coding-agent pipeline + sandbox" section above);
  `base-images/node/` is the custom image its ephemeral containers run.
- `coding-orchestrator/` — owns the coding-agent pipeline's actual
  Planner→Coder→Tester→Reviewer→retry state machine as real TypeScript
  (see the "architectural rethink" dated entry above); n8n keeps only a
  thin submit/status webhook proxy in front of it.
- `scripts/start-coding-task.mjs` — explicit trigger for the coding-agent
  pipeline, mirroring `chat.mjs`'s role as a reference client for the
  `Chat` webhook.
- `honcho-src/` — a clone of the Honcho OSS repo from when self-hosting was
  attempted. Unused now that Honcho runs hosted. Gitignored; safe to delete,
  kept only in case self-hosting is revisited (cost/privacy reasons).
- `scripts/` — `pull-models.sh` (pull required Ollama models),
  `export-n8n-workflows.sh` (see above), `chat.mjs` (CLI connectivity test /
  reference client — see below), `set-peer-cards.mjs` (one-time Honcho peer
  card bootstrap — see the peer cards section above), `benchmark-models.mjs`
  (benchmarks local Ollama models directly against the Ollama API — bypasses
  n8n — on tool-calling accuracy, general accuracy, and latency; writes
  JSON+Markdown reports to `benchmark-results/`, which backs the specific
  model-comparison numbers referenced in the tool-calling gotcha below).

## Setup

1. `cp .env.example .env` and fill in `POSTGRES_PASSWORD` (any strong
   random string) and `N8N_ENCRYPTION_KEY` (any strong random string).
2. `docker compose up -d`
3. **For the coding-agent sandbox** (see below): `docker network create
   sandbox-net` and `docker build -t sandbox-node-test:latest
   ./sandbox-runner/base-images/node`. Neither happens automatically —
   compose only auto-creates a network when some service's `networks:`
   list structurally attaches to it, and `sandbox-runner` only references
   `sandbox-net` by name (as the network its *spawned* containers join,
   not one it joins itself), so compose never sees it as "used." The base
   image is a plain `docker build`, not a compose service, for the same
   reason. Skip this if you're not using the coding-agent pipeline yet.
4. `bash scripts/pull-models.sh` — pulls `llama3.1:8b` and `nomic-embed-text`
   (`nomic-embed-text` was originally pulled for an abandoned self-hosted-Honcho
   attempt and sat unused; it's now genuinely load-bearing again, as the
   embedding model behind the Research workflow's `research_chunks.embedding`
   column — see that section below). This script is stale re: the *actual* chat model — the `Chat`
   workflow's `Ollama Chat Model` node is user-configured and has already
   moved on from `llama3.1:8b` (see the tool-calling gotcha below); pull
   whatever model you actually configure there yourself, e.g.
   `docker compose exec ollama ollama pull qwen3:8b`. `OLLAMA_WARMUP_MODEL`
   (default `llama3.2:3b`) is a separate, independent setting — keep it in
   sync with whatever the Chat workflow actually uses, or the warmup step
   preloads the wrong model.
5. Open n8n at http://localhost:5678, create an owner account, build/import
   the Chat workflow (see `n8n/workflows/` for the last exported copy — check
   its `updatedAt` against the live workflow in n8n before trusting it; see
   gotcha below).
6. On the Chat Trigger node: **Mode must be "Webhook"**, not "Hosted Chat"
   (see gotcha below). Toggle the workflow **Active**.
7. Add a Honcho API key as an n8n credential (HTTP Bearer Auth type) — get
   a key at [app.honcho.dev](https://app.honcho.dev) ($100 free credits to
   start). Never put this key in a file; n8n's credential vault is the only
   place it should live.
8. Optionally set `HOME_LOCATION` (a city name) or `HOME_LATITUDE`/
   `HOME_LONGITUDE` in `.env` so the `weather_get` tool has a default when
   the user doesn't name a city. Without this, `weather_get` still works for
   an explicitly named location, but returns a clear error (not a crash) if
   asked for "the weather" with no location given and none configured.
9. Optionally bootstrap the Honcho peer cards (see the peer cards section
   above) by editing the fact lists in `scripts/set-peer-cards.mjs` and
   running `HONCHO_API_KEY=... node scripts/set-peer-cards.mjs`. Not
   required — both cards start empty and fill in over time via Honcho's
   automatic dreaming — but this skips the cold-start gap.
10. Optionally set up `calendar_event` (Google Calendar). Create a Google
    Cloud project, enable the Calendar API, create a service account
    (IAM & Admin → Service Accounts → Create), generate a JSON key for it
    (Keys tab → Add Key → Create new key → JSON), and save that file as
    `skills-mcp/secrets/google-calendar-key.json` (gitignored) — **baked
    into the image at build time, not bind-mounted** (see the gotcha
    below), so run `docker compose up -d --build skills-mcp` after adding
    it, a plain restart won't pick it up. Share the target calendar with
    the service account's `client_email` (Google Calendar → calendar
    settings → "Share with specific people" → "Make changes to events"),
    then set `GOOGLE_CALENDAR_ID` in `.env` (your Gmail address for your
    primary calendar, or the calendar's ID from "Integrate calendar").
    Without this, `calendar_event` returns a clear "not configured" error
    rather than breaking anything.

## Testing connectivity

```powershell
$env:N8N_CHAT_WEBHOOK_URL = "http://localhost:5678/webhook/<your-webhook-id>/chat"
node scripts/chat.mjs "hey, are you there?"
```

Persists a session id locally (`.chat-session-id`, gitignored) so follow-up
messages stay in the same conversation. This CLI was also a rough
prototype of what the Pi's voice-command route now actually does: POST
transcribed text in, get reply text back (see "Smart-mirror dashboard"
above) — the prototype's shape held up unchanged.

## Known gotchas (learned the hard way)

- **`export-n8n-workflows.sh` must pass `--published` per-workflow, not
  `--all --published`.** Without `--published`, `export:workflow` returns
  the *draft*, which silently diverges from the live workflow whenever it
  was last changed via the CLI import/publish cycle (see the draft/publish
  gotcha below) instead of the UI. `--all --published` together is also
  unreliable on this n8n version (2.31.6) — it silently returned stale
  content for a workflow that `--id=X --published` (single-workflow form)
  correctly showed as current. The script now loops over `list:workflow`
  and exports each ID individually with `--published --separate`, falling
  back to a plain export only for workflows that have never been published
  (e.g. the empty `update_context` stub).
- **On this machine's Git Bash, any `/tmp/...`-style CLI argument gets
  silently rewritten to a Windows path** before reaching `docker`/`docker
  compose`, so a container-side path like `--output=/tmp/x.json` arrives
  mangled and every export fails with `ENOENT`. Fix: `export
  MSYS_NO_PATHCONV=1` before the `docker`/`docker compose` calls (no-op on
  real Linux/macOS shells).
- **`docker compose exec` (even with `-T`) still attaches the exec'd
  process's stdin to the host shell's stdin.** Piping a multi-line list
  straight into `while read` and calling `docker compose exec` inside the
  loop body lets each inner call consume the remaining piped lines, so the
  loop silently dies after one iteration. Fix: capture the list into a
  variable first and feed the loop via a here-string (`<<<`), and redirect
  every inner docker call's stdin from `/dev/null` for good measure.
- **This n8n version has a draft/publish system.** Editing
  `workflow_entity.nodes`/`connections` directly in postgres does **not**
  affect the live/active workflow — only `n8n export:workflow` /
  `import:workflow` / `publish:workflow` (CLI) or saving through the UI do.
  A container restart is required after `publish:workflow` for changes to
  take effect. If a workflow change "isn't taking effect," check this
  before assuming anything else is broken.
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
- **Never hand-build a JSON request body by splicing `{{ expressions }}`
  into a text blob.** Any interpolated value containing a newline (a
  multi-line LLM reply, for instance) produces invalid JSON ("Bad control
  character in string literal"). Build the object and let `JSON.stringify`
  handle escaping instead:
  `={{ JSON.stringify({ key: $json.value }) }}`
- **Bind mounts on this machine are unreliable**, independent of OneDrive.
  `docker cp` (used by `scripts/export-n8n-workflows.sh`) is the safe
  fallback when a bind mount silently shows an empty directory to a
  container — verify with a plain `docker run -v ... alpine ls` test before
  assuming it's the specific tool/image's fault.
- **A single-file bind mount can get stuck as a directory inside the
  container, persisting across recreation.** Hit twice: once with
  `ollama-mcp-bridge`'s config file, again with
  `skills-mcp`'s `google-calendar-key.json` — in both cases `docker
  compose up -d --force-recreate` (even a full `stop`/`rm -f`/`up`) still
  showed the mount target as an empty directory inside the container,
  same inode/timestamp as before, meaning Docker Desktop's VM was
  caching the broken mount at a level recreation doesn't touch. `stat
  <path>` inside the container (checking for `directory` vs. `regular
  file`) is the fast way to confirm this is what's happening, rather
  than assuming a code/permissions bug. **Fix that actually works**:
  stop bind-mounting the single file at runtime — `COPY` it into the
  image at build time instead (see `skills-mcp/Dockerfile`'s
  `google-calendar-key.json` handling). The file stays gitignored either
  way; only its filesystem location moves into the service's own build
  context so it's copyable at all.
- **A single `docker cp container:/dir/. dest/` (directory/wildcard) copy
  can silently do nothing on this machine** — exits 0, `set -e` doesn't
  catch it, destination is left untouched with no error printed. Copying
  files one at a time (`docker cp container:/dir/file dest/file` per file)
  has been reliable; `scripts/export-n8n-workflows.sh` was fixed to do this
  after it silently stopped updating `n8n/workflows/` for an entire session
  without any visible failure.
- **n8n autosaves the editor's in-memory state, which can silently clobber
  CLI-made changes.** If a workflow is open in a browser tab when it gets
  updated via `export:workflow`/`import:workflow`/`publish:workflow`, that
  tab's periodic autosave will write its *stale* cached nodes/connections
  back as a new draft version — reverting the draft while leaving the
  actually-running published version untouched underneath (check
  `workflow_entity.versionId` vs `activeVersionId`; a mismatch means the
  editor's draft has diverged from what's live). The risk: publishing or
  saving from that stale tab would overwrite the working live version too.
  Close or refresh the workflow's browser tab before/after any CLI-driven
  edit to it.
- **`n8n/workflows/` is a point-in-time snapshot, not a live sync.** Nothing
  keeps it current automatically — the live `Chat` workflow has drifted
  from its last export before (persona lookup, tools, and the Honcho
  `peer_id` were all added/changed live without a re-export). Check the
  workflow's `updatedAt` in n8n against the export's before assuming the
  file on disk reflects reality; re-run `scripts/export-n8n-workflows.sh`
  after any UI edit you want backed up. See the `--published` gotcha near
  the top of this section for why a naive export can also be stale even
  right after running it.
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
  - **Mitigation now in place** (see architecture diagram above): a
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
    is the same "3-5 tools" ceiling this project's tool-count guidance
    (see the persona section above) already flagged, now measured
    directly rather than assumed. `ollama-mcp-bridge` was removed after
    disproving the hypothesis it was deployed to test — it provided no
    benefit the native path doesn't already have once tool count is
    controlled.
  - **Fixed with dynamic, per-message tool-group filtering** — the
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
    `weather_get`) rather than bespoke n8n HTTP Request Tool nodes — see the
    architecture section above.
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
- **Fixed 2026-07-26 — the persona used to confabulate specific fake
  details** when a question didn't actually call for a tool it has — a
  fake meeting ("Johnson & Co"), fake traffic, or in one case a fabricated
  memory of a prior conversation that never happened. Fixed with a
  persona-prompt addition (in the `personas` Data Table's `system_prompt`
  column for "Amy", *not* a workflow — see the note below on why that
  needed a direct DB update rather than the export/import/publish cycle):
  an explicit instruction not to invent specific facts/events/details, with
  a suggested fallback phrase ("I don't have anything on that"), plus a
  clarification that the existing "answer from what you already know" rule
  (for hidden tool failures) means genuine background knowledge, never
  invented specifics. Verified against the exact three original failure
  modes (a meeting question, a traffic question, a fabricated-past-topic
  question) — all three now decline honestly instead of fabricating, and a
  plain greeting afterward confirmed the persona's normal character/wit is
  unaffected.
  - **Data Table rows have no draft/publish layer, unlike workflows** — n8n
    Data Tables are plain physical Postgres tables (`data_table` +
    `data_table_column` hold metadata, cascade-deleting on the parent row;
    each table's actual rows live in a dynamically-named
    `data_table_user_<id>` table) queried directly on every read, so a raw
    SQL `UPDATE` to a row's value takes effect immediately, no restart
    needed. This is a different risk profile from workflow JSON (see the
    draft/publish gotcha below) — editing a row's *value* is safe via SQL;
    dropping a whole table needs `DELETE FROM data_table WHERE id=...`
    (cascades to `data_table_column`) *and* a manual `DROP TABLE` on the
    physical `data_table_user_<id>` table, since that part isn't
    DB-enforced. This is how a dead `personality` Data Table (empty
    `content`/`synced_at` row, an abandoned earlier attempt at dynamic
    persona content — superseded by the peer-card approach above) got
    removed on 2026-07-26. The leftover
    `proposed_system_prompt`/`proposed_reason`/`proposed_at` *columns* on
    the still-live `personas` table (from the removed
    `propose_persona_change` feature) were left in place rather than
    dropped, since column-level changes are more likely to desync n8n's
    schema cache than a full table's metadata+physical-table pair — remove
    those via the Data Table UI if you want them gone. There's also a
    `skills` Data Table — that one backs the working "Skill proposals"
    feature described above, not stale; leave it alone.

- **n8n's `import:workflow` requires an explicit top-level `id` for a
  brand-new workflow** — it does not auto-generate one, and fails with
  `null value in column "id" of relation "workflow_entity" violates
  not-null constraint` if omitted. Generate one yourself (any short
  alphanumeric string) before importing a workflow that doesn't exist yet.
- **The Data Table node's filter `condition` operator string is `eq`, not
  `equal`.** Its zod parameter schema types `condition` as a bare
  `stringOrExpression` (no literal enum), so a wrong value passes schema
  validation silently and only fails at actual query-execution time —
  which, combined with `onError: continueRegularOutput`, means the node
  just **passes its input through unchanged** instead of erroring visibly.
  This produced a confusing symptom debugging `Get Active Skills`: its
  "output" was literally the *previous* node's data (peer cards), because
  the real query silently failed and the input passed through untouched.
  No existing example in this project used an explicit multi-condition
  filter to check against (`Get Persona`'s single-condition filter omits
  `condition` entirely) — check a node's actual `.operation.js`
  implementation (not just its `.schema.js`, which only validates shape,
  not accepted values) before assuming an operator string.
- **`alwaysOutputData` is needed on `Fetch Recent History` for the fallback
  chain to work on a brand-new session's very first turn.** If that turn's
  output is garbage/empty, `Postgres Chat Memory` never saves anything for
  it (nothing to save), so a fresh session has zero prior rows — and n8n
  does not execute a node's downstream connections at all when it receives
  zero input items. Without `alwaysOutputData: true` on `Fetch Recent
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
- **Explicitly naming a tool by its internal identifier in a prompt (e.g.
  "use the weather_get tool") reliably produces a completely empty raw
  completion from `qwen3:8b`** — confirmed generalizable, not specific to
  any one tool: reproduced 10/10 and 3/3 across two different *existing*
  tools (`weather_get`, `skill_propose`) with prompts that named the
  tool directly, vs. 0/10 and clean results for the same underlying request
  phrased naturally (describing the need, not naming the tool). Low
  practical impact — real users describe what they want rather than naming
  internal tool identifiers — but worth knowing if a test prompt ever
  reproduces empty output: check whether the prompt named a tool by name
  before assuming it's a new regression. The safety net's fallback chain
  handles this the same as any other empty-output case.
- **A close cousin of the above, much harder to spot: `qwen3:8b`'s tool-calling
  silently breaks once the tool's *name* (not the prompt) has too many
  underscore-separated segments — and n8n's MCP Client Tool node always
  adds segments you didn't ask for.** It prefixes every tool it exposes
  with its own node display name (e.g. a node named "Task Container Tool"
  turns `code_task_run_command` into
  `Task_Container_Tool_code_task_run_command`). Past roughly 5-6 combined
  segments, the model burns real generation tokens (a nonzero `eval_count`
  in the raw Ollama response) but the output never resolves into a
  `tool_calls` block — no error anywhere in the chain, n8n reports
  `execution.succeeded: true` with empty output. Confirmed by capturing the
  exact request/response bytes (a disposable logging reverse-proxy in
  front of Ollama) and replaying the identical request with only the tool
  name changed: `Task_Container_Tool_code_task_run_command` (8 segments)
  fails every time, bare `code_task_run_command` (4 segments) works every
  time. This is invisible in any n8n node's own configuration — the
  combined name only exists in the actual wire request. If a tool-calling
  agent's own tracing metadata shows `tool_calls.requested`/
  `iteration.count` stuck at 0 with no thrown error, check the *combined*
  tool name (MCP Client Tool node name + the underlying tool name) for
  segment count before assuming it's a config or infra bug — see the
  coding-agent pipeline section above for the full investigation and fix
  (`run_command`/`get_diff`, short tool names, matching this project's
  own convention of keeping identifiers terse).
- **`n8n execute --id=...` (CLI, one-off run) cannot exercise Data Table
  nodes** — it spins up an isolated sub-process alongside the real running
  server, and any Data Table node in it fails with `Attempted to use Data
  table node but the module is disabled`. It also can't start execution
  from a `Schedule Trigger` at all (`Missing node to start execution` —
  needs a literal `Execute Workflow Trigger` node). Neither is a real
  workflow bug — Data Table nodes work fine in the actual running server,
  proven daily by `Chat`/`skill_proposal_intake`. For a schedule-triggered
  workflow that uses Data Table nodes, don't try to test via `n8n execute`;
  temporarily redeploy with a short-but-valid recurring interval (see next
  gotcha) so the *real* server fires it, then revert.
- **`scheduleTrigger`'s `secondsInterval`/`minutesInterval`/etc. are
  validated against an undocumented 1–59 (or 1–23 for hours, 1–31 for
  days) range** — a value outside it doesn't error at import or publish
  time, only at *activation*, and fails with the unhelpful `Invalid
  interval` (no mention of which field or the actual valid range; found by
  reading `ScheduleTrigger`'s `validateInterval()` source directly). n8n
  retries activation forever with exponential backoff on failure rather
  than surfacing this anywhere in the UI/CLI output, so a workflow can look
  successfully imported and published while silently never actually
  running. Check `docker compose logs n8n` for `Activation of workflow ...
  did fail` if a schedule-triggered workflow never seems to fire.
- **`n8n execute` (CLI) silently ignores `pinData` entirely** — pinning a
  node's output in the workflow JSON (the normal way to feed synthetic
  test data into a specific node) has no effect on a CLI-triggered run;
  the node executes for real regardless, hitting whatever live system it
  actually calls. This isn't documented anywhere obvious and is easy to
  miss, since the CLI run completes without error — it just quietly uses
  real data instead of the pinned data, which can look like a false
  positive/negative depending on what the real data happens to contain.
  Pinning only works through the editor UI's "Execute Workflow" button.
  For CLI-testable synthetic scenarios, temporarily replace the node
  itself with a Code node that returns the fixed data literally, instead
  of trying to pin the real node.
- **`docker exec` needs `-i` to accept piped stdin.** Without it, a
  heredoc/pipe into `docker exec ... psql` (or any other command expecting
  stdin) silently does nothing — no error, the command just runs against
  empty input, which looked at first like the SQL itself had failed. Use
  `docker exec -i`.
- **A Code node in `runOnceForEachItem` mode must return a plain `{ json:
  {...} }` object, not an array-wrapped `[{ json: {...} }]`** — the latter
  is only correct for `runOnceForAllItems` mode. Getting this backwards
  produces a generic, unhelpful internal validation error ("A 'json'
  property isn't an object [item 0]") that doesn't name the offending
  node, thrown from `result-validation.ts` deep in n8n's Code node
  implementation — found by decoding the raw `execution_data` Postgres
  column (n8n uses the `flatted` npm package's serialization format, not
  plain JSON; `flatted.parse()` from inside the n8n container, requiring
  its full `.pnpm` path since it's not on the container's own `node`
  resolution path) to get the actual `lastNodeExecuted` and stack trace,
  since the workflow-level error message alone didn't identify which node
  was wrong. Cost real debugging time across three other hypotheses first
  (a suspected HTTP-node `onError` quirk on total connection failures, a
  missing merge/sync point) before the real cause — this exact return-
  shape mismatch, in three different `runOnceForEachItem` Code nodes at
  once — was found.
- **Global `fetch()` is not defined inside a Code node's sandboxed
  execution context** in this n8n version — confirmed by direct testing
  (`ReferenceError: fetch is not defined`, thrown from
  `@n8n/task-runner`'s `js-task-runner.js` inside a `vm.runInContext`
  call). A Code node that calls `fetch()` doesn't error loudly — if
  wrapped in a try/catch with a fallback (a reasonable, even
  recommended, defensive pattern elsewhere in this project), it silently
  falls through to that fallback on *every single execution*, indefinitely,
  with no visible symptom at all if the fallback happens to look
  plausible. Found this way: `dashboard_state`'s `Catalog Ready` node had
  been doing exactly this since it was built, never once actually
  reaching the Pi, invisible only because its hardcoded fallback catalog
  matches the real one's content. Use `this.helpers.httpRequest({method,
  url, body, json: true, timeout})` instead — the sanctioned way to make
  HTTP calls from inside a Code node — which returns the parsed response
  body directly (no `.json()` call needed). A genuine network round trip
  is easy to tell apart from a silent fallback afterward: check the
  node's `executionTime` in the decoded `execution_data` (see the gotcha
  above for how) — single-digit milliseconds means it never left the
  sandbox; hundreds of ms to low seconds means it actually made the call.
- **A Data Table `update` against zero matching rows fails with the same
  unhelpful "json property isn't an object" error, not a clean "0 rows
  updated"** — for a single "current state" row pattern (see the
  `personas`/`dashboard_state` tables), this bites when the seed row was
  never actually created (a UI setup step silently skipped). Use `upsert`
  instead of `update` for any table meant to always have exactly one
  current-state row — it's a drop-in replacement (identical
  `filters`/`columns` parameter shape) and makes the workflow self-healing
  if the row is ever missing.
- **Creating an n8n Data Table without the UI or a Public API key is
  possible, but only safely if you replicate n8n's own DDL exactly** —
  read `data-table-ddl.service.js` / `utils/sql-utils.js` inside the n8n
  image (`/usr/local/lib/node_modules/n8n/dist/modules/data-table/`)
  rather than guessing. The authoritative mapping: a `data_table` row
  (`id`, `name`, `projectId`) plus one `data_table_column` row per column
  (`type` is `'string'|'number'|'boolean'|'date'`), then a physical
  `data_table_user_<id>` table with `id INTEGER GENERATED BY DEFAULT AS
  IDENTITY PRIMARY KEY`, `createdAt`/`updatedAt`
  `TIMESTAMP(3) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP(3)`, and user
  columns mapped `string`→`TEXT`, `number`→`DOUBLE PRECISION`,
  `boolean`→`BOOLEAN`, `date`→`TIMESTAMPTZ` (Postgres; other DBs differ —
  same source file has the SQLite mapping too). Confirmed working
  end-to-end afterward via real workflow inserts/updates against the
  table, not just schema inspection.

## Not built yet (by design, deferred)

- `update_context` workflow — currently an empty stub, no nodes.
- Actually deleting the two `propose_persona_change` workflow entities in
  n8n. They're fully unpublished/inactive (dead — see the persona system
  section above) but n8n's CLI has no `delete:workflow` command, and
  hacking the DB directly to remove them risks the kind of draft/publish
  corruption documented below. Delete both via the n8n UI (Workflows list →
  ⋮ menu → Delete) when convenient. Until then, `list:workflow` still
  enumerates them, so `export-n8n-workflows.sh` will keep regenerating
  their JSON as draft-fallback exports in `n8n/workflows/` — harmless, just
  noise, delete those files again after the real deletion goes through.
- Fully suppressing the rare live `{}` flash (buffer-then-respond instead of
  token streaming) — see the tool-calling gotcha above.
- On-demand/progressive-disclosure loading for active instruction skills
  (a `use_skill` tool call instead of always injecting every active skill's
  full text into every turn) — only worth building once the always-inject
  approach actually causes prompt bloat with a larger skill library, not
  before.
- Actual code generation/implementation for `tool_idea` proposals via
  `skill_propose`/`skill_gap_scanner` themselves — this is now being
  actively worked on, just via a separate mechanism (see "Coding-agent
  pipeline + sandbox" above), not by extending those two directly.
- Raspberry Pi voice client's mic-to-text leg — see "Smart-mirror
  dashboard" above. Text-in → Chat webhook → TTS-out is fully working;
  `voice-daemon/listener.py` (openWakeWord + whisper.cpp, no Wyoming — see
  that section for why) is staged but untested, blocked on a microphone
  actually being attached to the Pi.
