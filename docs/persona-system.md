# Persona system

Part of the [Smart Assistant](../README.md) project. See
[`docs/chat-workflow.md`](chat-workflow.md) for where the resulting system
prompt is actually consumed, and
[`docs/honcho-memory.md`](honcho-memory.md) for the peer cards injected
alongside it.

The agent's identity lives in a `personas` Data Table in n8n (not in the
workflow JSON), one row per persona. Currently one row: **"Amy"** — a
written character/tone system prompt, not a neutral tool voice. The `Chat`
workflow's `Get Persona` node reads the `system_prompt` column for that row
and feeds it to the AI Agent as its system message, alongside the two
Honcho peer cards described in [`docs/honcho-memory.md`](honcho-memory.md).

**2026-09-21** — `chat-orchestrator` (see
[`docs/chat-orchestrator.md`](chat-orchestrator.md)), which now handles
real chat traffic instead of this workflow, reads the exact same
`system_prompt` column via a direct Postgres view rather than n8n's Data
Table API, and assembles the system prompt the same way (persona + date +
peer cards + skills catalog). The persona itself is still only ever edited
in n8n's Data Table UI — nothing about *how* Amy's identity is authored
changed, only which running service reads it for a live turn.

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
trigger — see [`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md)).
A deliberate addition, not scope creep sliding back past the guidance
above: it's a genuinely new capability with no existing tool to consolidate
it into, and it sits right at the edge of the 3–5 range rather than past
it. Worth revisiting the dynamic-tool-filtering option for real if
anything gets added beyond this.

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
documented real reliability problems with (see
[`docs/chat-workflow.md`](chat-workflow.md)'s tool-calling gotcha, and
`skill_propose`'s under-invocation). MCP the protocol isn't
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
draft/publish gotcha in [`docs/known-gotchas.md`](known-gotchas.md)), since
a direct DB edit wouldn't have taken effect. **Verified end-to-end against
the real running stack, not just a typecheck**: pulled the raw execution
data for a live test chat message directly from Postgres (`execution_data`)
and confirmed `web_search` was actually invoked by the agent (not just
present in `tools/list`) and correctly returned a "not configured" error
pre-`TAVILY_API_KEY`, which the persona's existing "never mention tool
failures" rule handled gracefully (the user-facing reply offered general
knowledge instead, no raw error leaked) — same safety net every other
optional tool already relies on. Past the 3-5 guidance discussed above,
same as `spotify_control` and `code_task` before it — added because a
concrete, just-observed gap justified it, not as routine growth.

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

## Known gotchas (learned the hard way)

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
    draft/publish gotcha in [`docs/known-gotchas.md`](known-gotchas.md)) —
    editing a row's *value* is safe via SQL; dropping a whole table needs
    `DELETE FROM data_table WHERE id=...` (cascades to `data_table_column`)
    *and* a manual `DROP TABLE` on the physical `data_table_user_<id>`
    table, since that part isn't DB-enforced. This is how a dead
    `personality` Data Table (empty `content`/`synced_at` row, an abandoned
    earlier attempt at dynamic persona content — superseded by the
    peer-card approach in [`docs/honcho-memory.md`](honcho-memory.md)) got
    removed on 2026-07-26. The leftover
    `proposed_system_prompt`/`proposed_reason`/`proposed_at` *columns* on
    the still-live `personas` table (from the removed
    `propose_persona_change` feature) were left in place rather than
    dropped, since column-level changes are more likely to desync n8n's
    schema cache than a full table's metadata+physical-table pair — remove
    those via the Data Table UI if you want them gone. There's also a
    `skills` Data Table — that one backs the working
    [Skill proposals](skill-proposals.md) feature, not stale; leave it
    alone.
