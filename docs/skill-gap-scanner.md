# `skill_gap_scanner` (autonomous self-reflection, human-gated)

Part of the [Smart Assistant](../README.md) project. See
[`docs/skill-proposals.md`](skill-proposals.md) for the reactive
counterpart this mirrors, and [`docs/idle-reflection.md`](idle-reflection.md)
for the sibling autonomous workflow that reuses its `Semantic Dedup Check`.

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
`pinData` gotcha in [`docs/known-gotchas.md`](known-gotchas.md) — doesn't
work for this), each scenario temporarily swaps the relevant upstream
node(s) for a literal Code node returning fixed synthetic output, deploys
with a throwaway `Execute Workflow Trigger` for one-off CLI runs, and
reverts afterward. All six passed with correctly-reasoned,
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
(see [`docs/smart-mirror-dashboard.md`](smart-mirror-dashboard.md)) used
the exact same pattern and had been hitting its catch block on *every
single run* since it was built — never once actually reaching the Pi's
`/api/widgets/catalog` endpoint — completely undetected because its
hardcoded fallback catalog happens to have identical content to the real
one. Fixed both nodes to use `this.helpers.httpRequest(...)` instead (the
sanctioned way to make HTTP calls from inside a Code node) — confirmed
genuinely fixed by real network round-trip timings afterward (500ms–1.1s)
replacing the previous instant, fallback-only executions (8–15ms).

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

## 2026-10 update — a second, broader autonomous loop now exists alongside this one

The Growth engine (see [`docs/growth-engine.md`](growth-engine.md) Phase 9)
built its own autonomous reflection loop (`growth_background.py`, every 30
minutes, judging recent `review_turns` and feeding actionable attributions
into the same observation/scoring pipeline every other Growth signal uses) —
not a replacement for this workflow, a parallel one with a broader signal
set (safety-net failures, user corrections, behavior feedback, teaching
sessions, judge-derived review scores, in addition to this scanner's own
gap-detection). `skill_gap_scan` is itself one of Growth's named source
types (`_SOURCE_DEFAULTS`), confirming this n8n workflow's own proposals are
now also an input Growth's scoring/promotion logic consumes, not something
it superseded. Worth checking directly in n8n (`list:workflow` /
`workflow_entity.active`, see
[`docs/known-gotchas.md`](known-gotchas.md)'s draft/publish notes) whether
this workflow is still scheduled and active day-to-day — this update is
based on reading `growth-engine.md` and `skills-mcp`/`chat-ui` source, not a
fresh live re-verification of the n8n side.
