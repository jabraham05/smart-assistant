# Known gotchas (learned the hard way)

Part of the [Smart Assistant](../README.md) project. Generic n8n/Docker/
tooling gotchas that aren't specific to any one system. System-specific
gotchas live with that system's own doc instead — see
[`docs/chat-workflow.md`](chat-workflow.md) for the `Chat` workflow's own
(the garbage-output safety net, trigger modes, `alwaysOutputData`
incidents) and [`docs/persona-system.md`](persona-system.md) for the
persona-confabulation fix.

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
  This produced a confusing symptom debugging `Get Active Skills` (see
  [`docs/chat-workflow.md`](chat-workflow.md)): its "output" was literally
  the *previous* node's data (peer cards), because the real query silently
  failed and the input passed through untouched. No existing example in
  this project used an explicit multi-condition filter to check against
  (`Get Persona`'s single-condition filter omits `condition` entirely) —
  check a node's actual `.operation.js` implementation (not just its
  `.schema.js`, which only validates shape, not accepted values) before
  assuming an operator string.
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
  (see [`docs/chat-workflow.md`](chat-workflow.md)) handles this the same
  as any other empty-output case.
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
  segment count before assuming it's a config or infra bug — see
  [`docs/coding-agent-pipeline.md`](coding-agent-pipeline.md) for the full
  investigation and fix (`run_command`/`get_diff`, short tool names,
  matching this project's own convention of keeping identifiers terse).
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
  plausible. Found this way: `dashboard_state`'s `Catalog Ready` node (see
  [`docs/smart-mirror-dashboard.md`](smart-mirror-dashboard.md)) had been
  doing exactly this since it was built, never once actually reaching the
  Pi, invisible only because its hardcoded fallback catalog matches the
  real one's content. Use `this.helpers.httpRequest({method,
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
