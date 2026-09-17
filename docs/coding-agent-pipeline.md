# Coding-agent pipeline + sandbox (in progress)

Part of the [Smart Assistant](../README.md) project. See
[`docs/skill-proposals.md`](skill-proposals.md) for the tool-idea proposal
mechanism this supersedes with real code changes, and
[`docs/known-gotchas.md`](known-gotchas.md) for the generic n8n/Docker
infrastructure quirks referenced below.

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
  the bind-mount gotchas in [`docs/known-gotchas.md`](known-gotchas.md))
  bind mounts have independently proven flaky on this exact machine.
  Cloning over the network sidesteps that entirely.
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
n8n's own DDL exactly — see
[`docs/known-gotchas.md`](known-gotchas.md) for how): `task_description`,
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

Fixed by shortening the actual registered MCP tool names (`code_task_run_command` → `run_command`, `code_task_get_diff` → `get_diff`, in `skills-mcp/src/tools/`) so there's headroom left for the mandatory node-name prefix — confirmed `Task_Tool_run_command` (4 segments) works reliably. Verified with two full end-to-end runs against the real fixture repo: both approved on the first attempt, both opened real PRs, with genuine non-empty output at every phase (Coder's own `STATUS:` line, Tester's real analysis, a passing `test_run`, a substantive Reviewer verdict). **If a similar "empty output, zero tool calls, no error" symptom ever resurfaces with a different tool/model combination: check the combined (node-name-prefixed) tool name length/segment count first** — it's invisible in the n8n UI and in any per-node config, only visible by capturing the actual bytes sent to the model. (See [`docs/known-gotchas.md`](known-gotchas.md) for the condensed, general form of this lesson.)

Also worth noting for next time: this project's own already-documented gotcha ("explicitly naming a tool by its internal identifier in a prompt reliably produces empty output from qwen3:8b" — see [`docs/known-gotchas.md`](known-gotchas.md)) is a close cousin of this bug and was independently re-discovered mid-investigation when the Tester Agent's system prompt referenced `code_task_get_diff` by name — removed in favor of describing what to do, not which tool to call.

### 2026-07-28 — deterministic repo fallback, two silent-crash fixes, and a `write_file` tool

A real user report ("it said it started it but I don't see it and now it can't find it") traced back to the Coder Agent hallucinating a fake repo URL (`https://github.com/your-username/simple-guessing-game`) for a from-scratch task instead of correctly omitting `repoUrl`. The deeper problem: `Create Task Container` had no fallback at all — a bad or invented `repoUrl` threw, and that error crashed the *entire n8n execution* before it ever reached `Update Row`/`Has Origin Session?`, leaving the row stuck at `status: running` forever with **no failure ever surfaced to chat**. Decided (per explicit user direction) that the workflow itself, not the model's judgment, should own where a task lands: `repoUrl` is still honored when genuinely given, but `sandbox-runner`'s `createTaskContainer` now tries the primary repo first and falls back to the shared `coding_tasks` landing repo on failure (`attemptCreateTaskContainer` in `sandbox-runner/src/executor.ts`, returning a failure reason instead of throwing; only throws if *both* the requested repo and the fallback fail). The n8n side gained `Container Created?` (IF) → `Build Infra Failure Record` on the failure branch, producing the exact same JSON shape `Merge PR Result`/`No PR` already produce so it plugs straight into the existing `Update Row` node — no changes needed to anything downstream.

Testing the fallback against a genuinely larger task (a full CLI game, not a one-line fixture fix) surfaced the same crash class a second time: the Coder Agent hitting its `maxIterations` cap also throws and kills the whole execution, same stuck-row-no-notification symptom. Fixed with the identical pattern at both agent nodes — `onError: "continueRegularOutput"`, a `Coder Succeeded?`/`Tester Succeeded?` IF node checking `$json.error`, and `Build Coder/Tester Failure Record` nodes matching the same established output shape. Iteration caps also raised (Coder 15→25, Tester 10→15) since the original caps were only ever exercised against tiny fixture tasks.

Also hit: `Prepare Row`'s Code node read `$env.CODING_TASKS_REPO_URL` — n8n blocks `$env` access in Code nodes by default (`N8N_BLOCK_ENV_ACCESS_IN_NODE`), and this was the first real test where that branch actually executed (every prior test supplied a real `repoUrl`, short-circuiting past it). Fixed by hardcoding the (non-sensitive) landing-repo URL directly rather than loosening the instance-wide setting.

With the crash fixed, the actual code-generation failure underneath it became visible: the Coder Agent's only way to write file content was `run_command` (`echo "..." > file`), which breaks the instant the content itself contains a double quote (e.g. `input("Enter your guess (1-100): ")`) — the embedded quote closes the outer `echo "..."` string early and silently produces an empty or truncated file, with no error anywhere. Added a dedicated `write_file` MCP tool (`skills-mcp/src/tools/code-task-write-file.ts`) that takes `filename`/`content` as separate parameters and writes the content as raw bytes over the container exec's own stdin stream (`writeFileInTaskContainer` in `sandbox-runner/src/executor.ts`, new `POST /task/:id/write-file` route) — the content never touches shell parsing at all, so there's nothing to quote. Verified directly against a file containing the exact failing Python snippet: byte-for-byte round-trip, including the embedded quotes. Wired into both `Task Tool`/`Tester Tool`'s `includeTools` (kept short — `write_file`, one segment, well under the node-name-prefix budget documented above) and both agents' system prompts, describing the capability rather than naming the tool identifier (per the gotcha above).

Re-running the same from-scratch task with the fixes above (row 64) surfaced one more real gap: the Coder wrote a correct `guess_game.py` on the first try (confirming `write_file` works end-to-end, not just in isolation), but the Tester Agent then hit its own iteration cap trying to run/verify it — because the shared `sandbox-node-test` base image (`sandbox-runner/base-images/node/Dockerfile`) has no Python interpreter at all, only Node. `Should Open PR?`'s `exitCode == 0` gate correctly kept this from ever reaching a PR, and the failsafe fix correctly surfaced it as a clean `give_up` instead of a crash — but the task genuinely couldn't succeed. Fixed by adding `python3 py3-pip` to the one shared base image (still one image for every task regardless of language — real per-task/per-language image selection is still the "not yet built" gap noted above, this just makes the single shared image cover the common case instead of Node-only).

**A second, more interesting root cause found the same way (row 66):** after Python was available, a re-run again ended in `give_up` on the Tester's iteration cap — but decoding the actual execution data (n8n's execution-data blob is `flatted`-encoded; parsed directly with the `flatted` npm package rather than guessing) showed the Coder Agent's first turn returned completely empty output with **zero tool calls**, confirmed via n8n's own agent tracing (`tool_calls.requested: 0, tool_calls.completed: 0, output: ""`) and cross-checked against n8n's logs — the call genuinely ran for the full 11.6 seconds (not a fast-fail) and happened to land exactly as Ollama was evicting/reloading the qwen3:8b weights for GPU VRAM pressure freed up by the prior Planner call finishing. `Coder Succeeded?` only checked that `$json.error` was empty — a no-op, zero-tool-call response has no `error` field either, so it silently passed through as "success," and the entire implementation burden fell on the Tester (confirmed in its own tool-call trace: it ended up writing *both* `guess_game.py` and `test_guess_game.py` itself, on top of its actual job, and predictably ran out of its 15-iteration budget mid-way through fighting an unrelated pip/PATH issue).

Fixed two ways: (1) `Coder Succeeded?` now also requires non-empty `$json.output`, so a no-op turn is caught as a real failure instead of silently passing through; (2) added a one-shot `Coder Agent Retry` node (same model/tools/system-prompt as `Coder Agent`, plus one sentence noting it's a retry) wired off the failure branch, with its own `Coder Retry Succeeded?` check before falling through to the existing `Build Coder Failure Record`. Deliberately *not* a loop-back-with-counter — an AI Agent node's output completely replaces whatever fields rode in on its input, so a retry counter can't just ride along in `$json`, and n8n's cross-run self-reference semantics for a genuinely looped node weren't worth gambling on without extensive live verification. A dedicated second node guarantees exactly one extra attempt with none of that risk. `Update Status After Coder` also had to change: it hardcoded `$('Coder Agent').item.json.output` to pull the `STATUS:` line, which would keep reading the *original* (empty) Coder Agent's output even when the retry succeeded — switched to `$json.content` (from `Log Coder Round`'s own insert result, confirmed live that a Data Table insert echoes back the exact column values it just wrote) so it correctly reflects whichever agent actually produced the real output.

### 2026-07-30 — architectural rethink: `coding-orchestrator` replaces `coding_task_pipeline`'s state machine

After the fixes above, the pipeline kept hitting *new* failure modes at roughly the same rate fixes landed: n8n's implicit pairedItem lineage silently breaking through an AI Agent node's error branch (`$('Node').item.json` resolving fine on a happy path, then throwing "prompt could not be resolved" the moment the same reference is read after a Coder/Tester retry), a node emitting zero items silently skipping every downstream node (the same class of bug already hit once in the Chat workflow's `Get Active Skills`, see [`docs/chat-workflow.md`](chat-workflow.md)), and two `httpRequest` nodes (`Coder Agent Retry`, and separately the Chat workflow's own `AI Agent`) missing the `onError: continueRegularOutput` every sibling node had — the exact gap that turned an ordinary max-iterations error into a hard crash with no recovery. Asked directly to rethink the architecture rather than patch the next spot, a full audit of the live workflow (54 nodes, 62 edges) turned up further real gaps: `Tester Succeeded?` only checked for an absent error, not non-empty output (unlike `Coder Succeeded?`); the Tester never received retry feedback the Coder did; give-up paths skipped `Destroy Task Container` entirely (masked only by `sandbox-runner`'s own independent idle-container reaper); and — found live, mid-review — `sandbox-runner`'s per-container 100-command cap colliding with the *new* retry mechanism, since more attempts means far more cumulative tool calls than before.

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
