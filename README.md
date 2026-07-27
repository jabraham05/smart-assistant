# Smart Assistant

A self-hosted, self-learning personal AI assistant. n8n orchestrates a local
Ollama model as the "brain," Honcho (hosted cloud) provides long-term memory
of who you are, and postgres/redis back everything. Long-term goal: an
ever-growing library of skills (n8n workflows), a background job that
proposes new skills on its own (with a human approval gate before anything
goes live), and a Raspberry Pi voice interface.

## Architecture

```
Chat client (n8n test chat / scripts/chat.mjs / chat-ui / future Pi)
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
  `code_task` as of this writing) — added by registering each in `server.ts` following the
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
- **postgres** (`pgvector/pgvector:pg16`) — backs n8n itself and the
  Postgres Chat Memory node. pgvector is enabled for future use even though
  nothing local currently needs vectors (Honcho's vectors live in their
  cloud, not here).
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

## Directory layout

- `docker-compose.yml` — the whole stack.
- `postgres/init/` — one-time DB init scripts (creates the `n8n` database;
  runs once against an empty volume only).
- `n8n/workflows/` — exported workflow JSON, for history/diffing. Edit
  workflows in the n8n UI, then run `scripts/export-n8n-workflows.sh`.
- `chat-ui/` — Next.js custom web chat client, wired into
  `docker-compose.yml` (builds from `chat-ui/Dockerfile`, serves on
  `:3000`). Proxies chat through the n8n webhook and reads session
  list/history from Honcho.
- `skills-mcp/` — MCP server hosting agent-callable tools
  (`memory_recall`, `weather_get`, `skill_propose`, `calendar_event`,
  `code_task`), wired into `docker-compose.yml` (builds from
  `skills-mcp/Dockerfile`, internal-only, no published port). n8n's `Chat`
  workflow reaches it via an `MCP Client Tool` node.
- `sandbox-runner/` — Docker-outside-of-Docker sandbox for the coding-agent
  pipeline (see the "Coding-agent pipeline + sandbox" section above);
  `base-images/node/` is the custom image its ephemeral containers run.
- `scripts/start-coding-task.mjs` — explicit trigger for
  `coding_task_pipeline`, mirroring `chat.mjs`'s role as a reference
  client for the `Chat` webhook.
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
   (`nomic-embed-text` was for a self-hosted-Honcho attempt and is optional
   now). This script is stale re: the *actual* chat model — the `Chat`
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

## Testing connectivity

```powershell
$env:N8N_CHAT_WEBHOOK_URL = "http://localhost:5678/webhook/<your-webhook-id>/chat"
node scripts/chat.mjs "hey, are you there?"
```

Persists a session id locally (`.chat-session-id`, gitignored) so follow-up
messages stay in the same conversation. This CLI is also a rough prototype
of what the future Raspberry Pi voice client will do: POST transcribed text
in, get reply text back.

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
- Raspberry Pi voice client (OpenWakeWord + whisper.cpp + Piper, via the
  Wyoming protocol).
