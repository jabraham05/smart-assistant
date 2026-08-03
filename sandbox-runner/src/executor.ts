import Docker from "dockerode";
import type { Config } from "./config.js";

export interface ExecuteRequest {
  repoUrl: string;
  ref?: string;
  patch?: string; // unified diff, plain text
  testCommand: string;
  timeoutSeconds?: number;
}

export interface ExecuteResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ProposePrRequest {
  repoUrl: string;
  baseRef?: string;
  patch: string;
  branchName: string;
  commitMessage: string;
  prTitle: string;
  prBody?: string;
}

export interface ProposePrResult {
  pushed: boolean;
  prUrl?: string;
  error?: string;
  pushExitCode: number | null;
  pushStdout: string;
  pushStderr: string;
}

// Docker multiplexes stdout/stderr into one stream when Tty is false: each
// frame is an 8-byte header (stream type + big-endian uint32 size) followed
// by that many bytes of payload. Demuxing manually here avoids needing the
// stream-based modem.demuxStream helper for what `container.logs()` already
// hands back as a single Buffer in non-follow mode.
function demuxLogs(buffer: Buffer): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    const chunk = buffer.subarray(start, end).toString("utf8");
    if (streamType === 2) {
      stderr += chunk;
    } else {
      stdout += chunk;
    }
    offset = end;
  }
  return { stdout, stderr };
}

// Shared container lifecycle: create -> start -> wait (with a hard
// timeout) -> capture logs -> always remove, regardless of outcome. Both
// runInSandbox (read-only test execution) and proposePullRequest's push
// step (the only place this service ever writes anything) go through
// this same disposable-container path - same security posture either
// way (no docker.sock, non-root, isolated network, resource caps).
async function runEphemeralContainer(
  config: Config,
  opts: { cmd: string; env: string[]; timeoutSeconds?: number },
): Promise<ExecuteResult> {
  const docker = new Docker({ socketPath: config.dockerSocketPath });
  const startTime = Date.now();

  const container = await docker.createContainer({
    Image: config.nodeImage,
    Cmd: ["sh", "-c", opts.cmd],
    Env: opts.env,
    Tty: false,
    HostConfig: {
      NetworkMode: config.sandboxNetwork,
      Memory: config.memoryLimitBytes,
      NanoCpus: config.nanoCpus,
      PidsLimit: config.pidsLimit,
      Privileged: false,
      AutoRemove: false, // removed manually below, after logs are captured
    },
  });

  let timedOut = false;
  let timer: NodeJS.Timeout;
  const timeoutMs = (opts.timeoutSeconds ?? config.defaultTimeoutSeconds) * 1000;

  try {
    await container.start();

    const waitPromise = container.wait();
    const timeoutPromise = new Promise<{ StatusCode: number }>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        container.kill().catch(() => {});
        resolve({ StatusCode: -1 });
      }, timeoutMs);
    });

    const result = (await Promise.race([waitPromise, timeoutPromise])) as { StatusCode: number };
    clearTimeout(timer!);

    const logsBuffer = (await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    })) as unknown as Buffer;
    const { stdout, stderr } = demuxLogs(logsBuffer);

    return {
      exitCode: timedOut ? null : result.StatusCode,
      stdout,
      stderr,
      timedOut,
      durationMs: Date.now() - startTime,
    };
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

// repoUrl/ref/testCommand/patch are passed as env vars (not interpolated
// into the script text) so arbitrary characters in a test command never
// need shell-escaping here - this script only ever runs inside the
// disposable, network-isolated, resource-capped container, never on the
// host.
// A failed patch apply must hard-abort, not just log a code and fall
// through to the test command - otherwise the test command runs against
// the unmodified base repo and can pass vacuously, crediting a change
// that never actually happened (found via a real pipeline run: the
// Coder's diff didn't match the real file, patch silently failed both
// hunks, and "npm run build" then passed against the untouched original
// file - the Reviewer had no way to tell the difference from the exit
// code alone). Exit 97 is a distinctive marker, not a real test-runner
// code, so this failure mode is unambiguous in logs.
const RUN_SCRIPT = `set -o pipefail
git clone --depth 1 --branch "$REF" "$REPO_URL" /work/repo
cd /work/repo || exit 1
if [ -n "$PATCH_B64" ]; then
  echo "$PATCH_B64" | base64 -d > /tmp/patch.diff
  patch -p1 --fuzz=3 --no-backup-if-mismatch < /tmp/patch.diff
  PATCH_EXIT_CODE=$?
  echo "PATCH_APPLY_EXIT_CODE:$PATCH_EXIT_CODE" >&2
  if [ "$PATCH_EXIT_CODE" -ne 0 ]; then
    echo "ABORTING: patch failed to apply, refusing to run tests against an unmodified repo" >&2
    exit 97
  fi
fi
eval "$TEST_COMMAND"
`;

// Private repos (this project's own remote included) can't be cloned
// anonymously - embed the token the same way proposePullRequest's push
// does, but only for github.com http(s) URLs. Left untouched for
// anything else (e.g. the git:// fixture URLs used in earlier phases'
// synthetic testing), since basic-auth credentials aren't meaningful for
// the git:// protocol and would otherwise corrupt the URL.
function maybeAuthenticateCloneUrl(repoUrl: string, token: string | undefined): string {
  if (!token) return repoUrl;
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return repoUrl;
  }
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.endsWith("github.com")) {
    return buildAuthenticatedUrl(repoUrl, token);
  }
  return repoUrl;
}

export async function runInSandbox(config: Config, req: ExecuteRequest): Promise<ExecuteResult> {
  const cloneUrl = maybeAuthenticateCloneUrl(req.repoUrl, config.githubToken);

  const result = await runEphemeralContainer(config, {
    cmd: RUN_SCRIPT,
    env: [
      `REPO_URL=${cloneUrl}`,
      `REF=${req.ref ?? "main"}`,
      `TEST_COMMAND=${req.testCommand}`,
      ...(req.patch ? [`PATCH_B64=${Buffer.from(req.patch, "utf8").toString("base64")}`] : []),
    ],
    timeoutSeconds: req.timeoutSeconds,
  });

  // Same leak concern as proposePullRequest's push step: git's own error
  // output can echo the clone URL back verbatim, and this one may now
  // carry an embedded token.
  if (cloneUrl !== req.repoUrl) {
    const scrub = (s: string) => s.split(cloneUrl).join("<clone-url-redacted>");
    return { ...result, stdout: scrub(result.stdout), stderr: scrub(result.stderr) };
  }
  return result;
}

// Clones at baseRef, creates a new branch, applies the patch, commits, and
// pushes - using an authenticated clone URL (token embedded as the
// username via HTTPS Basic Auth, GitHub's documented pattern for PAT-based
// git operations) so this also works against private repos. The token is
// passed as an env var to this ephemeral container only, for exactly the
// duration of this one push - never logged, never returned, never seen
// by n8n.
const PUSH_SCRIPT = `set -o pipefail
git clone --branch "$BASE_REF" "$PUSH_URL" /work/repo
cd /work/repo || exit 1
git checkout -b "$BRANCH_NAME"
echo "$PATCH_B64" | base64 -d > /tmp/patch.diff
patch -p1 --fuzz=3 --no-backup-if-mismatch < /tmp/patch.diff
PATCH_EXIT_CODE=$?
echo "PATCH_APPLY_EXIT_CODE:$PATCH_EXIT_CODE" >&2
if [ "$PATCH_EXIT_CODE" -ne 0 ]; then
  echo "ABORTING: patch failed to apply, refusing to commit/push an unmodified repo" >&2
  exit 97
fi
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
git add -A
git commit -m "$COMMIT_MESSAGE"
git push "$PUSH_URL" "$BRANCH_NAME"
`;

function buildAuthenticatedUrl(repoUrl: string, token: string): string {
  const url = new URL(repoUrl);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

function parseGithubOwnerRepo(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(\.git)?\/?$/);
  if (!match) {
    throw new Error(`Could not parse a GitHub owner/repo from "${repoUrl}"`);
  }
  return { owner: match[1], repo: match[2] };
}

export async function proposePullRequest(
  config: Config,
  req: ProposePrRequest,
): Promise<ProposePrResult> {
  if (!config.githubToken) {
    return {
      pushed: false,
      error: "GITHUB_TOKEN is not configured",
      pushExitCode: null,
      pushStdout: "",
      pushStderr: "",
    };
  }

  const pushUrl = buildAuthenticatedUrl(req.repoUrl, config.githubToken);
  const pushResult = await runEphemeralContainer(config, {
    cmd: PUSH_SCRIPT,
    env: [
      `PUSH_URL=${pushUrl}`,
      `BASE_REF=${req.baseRef ?? "main"}`,
      `BRANCH_NAME=${req.branchName}`,
      `PATCH_B64=${Buffer.from(req.patch, "utf8").toString("base64")}`,
      `GIT_AUTHOR_NAME=${config.gitAuthorName}`,
      `GIT_AUTHOR_EMAIL=${config.gitAuthorEmail}`,
      `COMMIT_MESSAGE=${req.commitMessage}`,
    ],
  });

  // The push URL (with the embedded token) can appear in git's own error
  // output on failure (e.g. an invalid-URL or auth error message may echo
  // the remote back) - scrub it defensively before this ever leaves the
  // process, since pushStdout/pushStderr do get returned to the caller.
  const scrub = (s: string) => s.split(pushUrl).join("<push-url-redacted>");

  if (pushResult.exitCode !== 0) {
    const error =
      pushResult.exitCode === 97
        ? "Patch failed to apply against the base branch - nothing was committed or pushed"
        : `git push failed (exit code ${pushResult.exitCode})`;
    return {
      pushed: false,
      error,
      pushExitCode: pushResult.exitCode,
      pushStdout: scrub(pushResult.stdout),
      pushStderr: scrub(pushResult.stderr),
    };
  }

  try {
    const { owner, repo } = parseGithubOwnerRepo(req.repoUrl);
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: req.prTitle,
        head: req.branchName,
        base: req.baseRef ?? "main",
        body: req.prBody ?? "",
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        pushed: true,
        error: `Branch pushed, but PR creation failed: ${res.status} ${body}`,
        pushExitCode: pushResult.exitCode,
        pushStdout: scrub(pushResult.stdout),
        pushStderr: scrub(pushResult.stderr),
      };
    }

    const json = (await res.json()) as { html_url: string };
    return {
      pushed: true,
      prUrl: json.html_url,
      pushExitCode: pushResult.exitCode,
      pushStdout: scrub(pushResult.stdout),
      pushStderr: scrub(pushResult.stderr),
    };
  } catch (e) {
    return {
      pushed: true,
      error: `Branch pushed, but PR creation threw: ${e instanceof Error ? e.message : String(e)}`,
      pushExitCode: pushResult.exitCode,
      pushStdout: scrub(pushResult.stdout),
      pushStderr: scrub(pushResult.stderr),
    };
  }
}

// ---------------------------------------------------------------------------
// Persistent task containers (agentic coding pipeline).
//
// Unlike everything above, a task container survives across many exec calls
// - it's created once per coding task, lives for the whole task (possibly
// several Coder rounds), and is destroyed only once the task's retry loop
// actually exits. Isolation is identical to the ephemeral path (same
// HostConfig: sandboxNetwork, memory/cpu/pids caps, non-root image user,
// Privileged:false, no docker.sock passthrough) - only lifecycle differs.
//
// GITHUB_TOKEN must never be read anywhere in this section. It's scoped to
// proposePullRequest's one-shot push above, on purpose (n8n persists every
// workflow execution's node I/O in Postgres in plaintext, so a token
// flowing through a long-lived task container that the model has shell
// access in would be a real credential leak risk). If a private repo ever
// needs cloning here, embed the token in the clone URL only, the same way
// runInSandbox already does - never let it land in the container's env or
// process list afterward.

const TASK_LABEL_KEY = "smart-assistant.task-id";
const TASK_CREATED_AT_LABEL_KEY = "smart-assistant.created-at";

// In-memory only, by design: last-exec-activity per container (drives the
// idle reaper) and a running exec count per container (server-side
// maxCommandsPerTask cap, independent of whatever cap n8n's AI Agent node
// applies). Lost on a sandbox-runner restart - acceptable, since the
// label-derived max-lifetime cap alone still bounds the worst case in that
// rare scenario.
const lastActivityByContainer = new Map<string, number>();
const commandCountByContainer = new Map<string, number>();

let dockerClient: Docker | undefined;
function getDocker(config: Config): Docker {
  if (!dockerClient) {
    dockerClient = new Docker({ socketPath: config.dockerSocketPath });
  }
  return dockerClient;
}

export interface CreateTaskContainerRequest {
  repoUrl: string;
  ref?: string;
  // Subfolder within the cloned repo this task is scoped to. Empty string
  // for a normal existing-repo task (the whole clone is the working dir);
  // a slug for a from-scratch task sharing one landing repo with other
  // tasks, each in its own folder.
  projectFolder?: string;
  taskId: string;
  // If the primary repoUrl/ref/projectFolder fails to clone (bad/invented
  // URL, wrong ref, repo genuinely doesn't exist), retry once against this
  // known-good landing repo instead of throwing - callers (the coding
  // task pipeline) can't fully trust a model-supplied repoUrl, and a
  // clone failure used to crash the whole n8n execution with the task's
  // row stuck at "running" forever and no failure notification ever sent,
  // since the crash happened before the row-update/notify steps.
  fallbackRepoUrl?: string;
  fallbackRef?: string;
  fallbackProjectFolder?: string;
}

export interface CreateTaskContainerResult {
  containerId: string;
  workingDir: string;
  // True when the primary repoUrl failed and the fallback was used instead
  // - the caller needs this to correct the task's own record of which
  // repo/folder it's actually working against (e.g. so the eventual PR
  // targets the repo that was really cloned, not the one that was asked
  // for but didn't exist).
  usedFallback: boolean;
  actualRepoUrl: string;
  actualProjectFolder: string;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// PID 1 is `git clone && mkdir -p ... && tail -f /dev/null` - if the clone
// fails, the `&&` chain short-circuits and the container exits almost
// immediately. A successful clone (even a slow one) leaves the container
// running well past this grace window, so polling once after a short delay
// distinguishes "genuinely failed to start" from "still cloning" without
// blocking the caller on a potentially large clone.
const TASK_CONTAINER_START_GRACE_MS = 2000;

interface AttemptResult {
  ok: boolean;
  containerId?: string;
  workingDir?: string;
  failureReason?: string;
}

async function attemptCreateTaskContainer(
  config: Config,
  opts: { repoUrl: string; ref?: string; projectFolder: string; taskId: string },
): Promise<AttemptResult> {
  const docker = getDocker(config);
  const cloneUrl = maybeAuthenticateCloneUrl(opts.repoUrl, config.githubToken);

  const container = await docker.createContainer({
    Image: config.nodeImage,
    Cmd: [
      "sh",
      "-c",
      'git clone --depth 1 --branch "$REF" "$REPO_URL" /work/repo && mkdir -p "/work/repo/$PROJECT_FOLDER" && tail -f /dev/null',
    ],
    Env: [`REPO_URL=${cloneUrl}`, `REF=${opts.ref ?? "main"}`, `PROJECT_FOLDER=${opts.projectFolder}`],
    Tty: false,
    Labels: {
      [TASK_LABEL_KEY]: opts.taskId,
      [TASK_CREATED_AT_LABEL_KEY]: String(Date.now()),
    },
    HostConfig: {
      NetworkMode: config.sandboxNetwork,
      Memory: config.memoryLimitBytes,
      NanoCpus: config.nanoCpus,
      PidsLimit: config.pidsLimit,
      Privileged: false,
      AutoRemove: false,
    },
  });

  await container.start();
  await new Promise((resolve) => setTimeout(resolve, TASK_CONTAINER_START_GRACE_MS));

  const info = await container.inspect();
  if (!info.State.Running) {
    const logsBuffer = (await container.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
    const { stdout, stderr } = demuxLogs(logsBuffer);
    await container.remove({ force: true }).catch(() => {});
    return {
      ok: false,
      failureReason: `stdout=${stdout.slice(0, 500)} stderr=${stderr.slice(0, 500)}`,
    };
  }

  const containerId = container.id;
  lastActivityByContainer.set(containerId, Date.now());
  commandCountByContainer.set(containerId, 0);

  return {
    ok: true,
    containerId,
    workingDir: opts.projectFolder ? `/work/repo/${opts.projectFolder}` : "/work/repo",
  };
}

export async function createTaskContainer(
  config: Config,
  req: CreateTaskContainerRequest,
): Promise<CreateTaskContainerResult> {
  const primary = await attemptCreateTaskContainer(config, {
    repoUrl: req.repoUrl,
    ref: req.ref,
    projectFolder: req.projectFolder ?? "",
    taskId: req.taskId,
  });

  if (primary.ok) {
    return {
      containerId: primary.containerId!,
      workingDir: primary.workingDir!,
      usedFallback: false,
      actualRepoUrl: req.repoUrl,
      actualProjectFolder: req.projectFolder ?? "",
    };
  }

  if (!req.fallbackRepoUrl) {
    throw new Error(`Task container failed to start (likely clone failure): ${primary.failureReason}`);
  }

  const fallback = await attemptCreateTaskContainer(config, {
    repoUrl: req.fallbackRepoUrl,
    ref: req.fallbackRef,
    projectFolder: req.fallbackProjectFolder ?? "",
    taskId: req.taskId,
  });

  if (!fallback.ok) {
    // Both the requested repo AND the known-good landing repo failed to
    // clone - this is no longer "the model guessed a bad URL", it's a
    // real infrastructure problem (network, GitHub, or sandbox-runner
    // itself). Surface both failure reasons rather than masking the
    // fallback's own error.
    throw new Error(
      `Task container failed for both the requested repo (${primary.failureReason}) and the fallback repo (${fallback.failureReason})`,
    );
  }

  return {
    containerId: fallback.containerId!,
    workingDir: fallback.workingDir!,
    usedFallback: true,
    actualRepoUrl: req.fallbackRepoUrl,
    actualProjectFolder: req.fallbackProjectFolder ?? "",
  };
}

export interface ExecInTaskContainerRequest {
  containerId: string;
  workingDir: string;
  command: string;
  timeoutSeconds?: number;
}

export class TaskContainerNotFoundError extends Error {
  constructor(containerId: string) {
    super(`Task container ${containerId} was not found (it may already have been reaped or destroyed)`);
    this.name = "TaskContainerNotFoundError";
  }
}

// Distinguishable from a generic execution failure: callers (the coding
// orchestrator) can treat this as an expected "ran out of budget" outcome
// rather than a crash, matched on a real error type/HTTP status instead of
// string-matching the message text.
export class CommandLimitExceededError extends Error {
  constructor(limit: number) {
    super(`This task's container has already run ${limit} commands - refusing to run more`);
    this.name = "CommandLimitExceededError";
  }
}

export async function execInTaskContainer(
  config: Config,
  req: ExecInTaskContainerRequest,
): Promise<ExecuteResult> {
  const docker = getDocker(config);
  const startTime = Date.now();

  const requestedTimeout = req.timeoutSeconds ?? config.execDefaultTimeoutSeconds;
  const timeoutSeconds = Math.min(requestedTimeout, config.execMaxTimeoutSeconds);

  const commandCount = (commandCountByContainer.get(req.containerId) ?? 0) + 1;
  if (commandCount > config.maxCommandsPerTask) {
    throw new CommandLimitExceededError(config.maxCommandsPerTask);
  }
  commandCountByContainer.set(req.containerId, commandCount);
  lastActivityByContainer.set(req.containerId, Date.now());

  const container = docker.getContainer(req.containerId);

  let exec;
  try {
    // CMD passed as an env var, not interpolated into the script text, so
    // arbitrary characters in a model-issued command never need shell-
    // escaping here - same idiom RUN_SCRIPT already uses above. `timeout`
    // wraps the command itself because dockerode has no way to kill an
    // individual exec process from the host side once it's running -
    // container.kill() would take down the whole task, not just one call.
    exec = await container.exec({
      Cmd: ["sh", "-c", `timeout ${timeoutSeconds}s sh -c "$CMD"`],
      Env: [`CMD=${req.command}`],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: req.workingDir,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("404") || message.toLowerCase().includes("no such container")) {
      throw new TaskContainerNotFoundError(req.containerId);
    }
    throw e;
  }

  const stream = await exec.start({ hijack: true, stdin: false });
  const buffer = await streamToBuffer(stream as unknown as NodeJS.ReadableStream);
  const { stdout, stderr } = demuxLogs(buffer);

  const inspectResult = await exec.inspect();
  const exitCode = inspectResult.ExitCode;
  // `timeout` reports 124 when it had to kill the wrapped command itself.
  const timedOut = exitCode === 124;

  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
    durationMs: Date.now() - startTime,
  };
}

export interface WriteFileInTaskContainerRequest {
  containerId: string;
  workingDir: string;
  filename: string;
  content: string;
}

// The one prior attempt at "creating file content" went through
// execInTaskContainer's `sh -c "$CMD"` path with a model-authored
// `echo "..." > file` command - which breaks the moment the content itself
// contains a double quote, since that closes the outer shell string early.
// This writes the content as raw bytes over the exec's own stdin stream
// instead of embedding it in a command string at all, so nothing about the
// file content is ever parsed by a shell - there is no quoting to get wrong.
export async function writeFileInTaskContainer(
  config: Config,
  req: WriteFileInTaskContainerRequest,
): Promise<ExecuteResult> {
  if (req.filename.startsWith("/") || req.filename.split("/").includes("..")) {
    throw new Error(
      `filename must be a relative path within the task's working directory, got: ${req.filename}`,
    );
  }

  const docker = getDocker(config);
  const startTime = Date.now();

  const commandCount = (commandCountByContainer.get(req.containerId) ?? 0) + 1;
  if (commandCount > config.maxCommandsPerTask) {
    throw new CommandLimitExceededError(config.maxCommandsPerTask);
  }
  commandCountByContainer.set(req.containerId, commandCount);
  lastActivityByContainer.set(req.containerId, Date.now());

  const container = docker.getContainer(req.containerId);

  let exec;
  try {
    // FILENAME goes through Env, same as CMD does in execInTaskContainer -
    // the shell only ever sees the *path*, never the file's contents.
    exec = await container.exec({
      Cmd: ["sh", "-c", 'mkdir -p "$(dirname "$FILENAME")" && cat > "$FILENAME"'],
      Env: [`FILENAME=${req.filename}`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: req.workingDir,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("404") || message.toLowerCase().includes("no such container")) {
      throw new TaskContainerNotFoundError(req.containerId);
    }
    throw e;
  }

  const stream = await exec.start({ hijack: true, stdin: true });
  stream.write(req.content);
  stream.end();
  const buffer = await streamToBuffer(stream as unknown as NodeJS.ReadableStream);
  const { stdout, stderr } = demuxLogs(buffer);

  const inspectResult = await exec.inspect();
  const exitCode = inspectResult.ExitCode;

  return {
    exitCode,
    stdout,
    stderr,
    timedOut: false,
    durationMs: Date.now() - startTime,
  };
}

export interface DiffTaskContainerRequest {
  containerId: string;
  workingDir: string;
}

export async function diffTaskContainer(
  config: Config,
  req: DiffTaskContainerRequest,
): Promise<{ diff: string }> {
  // `add -A -N` (intent-to-add) is what makes brand-new files show up in
  // `git diff` at all - plain `git diff` only ever shows changes to files
  // git already knows about, which would silently drop any file the model
  // created from scratch.
  const result = await execInTaskContainer(config, {
    containerId: req.containerId,
    workingDir: req.workingDir,
    command: "git add -A -N && git -c color.ui=false diff",
    timeoutSeconds: config.execMaxTimeoutSeconds,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git diff failed inside task container (exit ${result.exitCode}): ${result.stderr}`);
  }
  return { diff: result.stdout };
}

export async function destroyTaskContainer(config: Config, containerId: string): Promise<void> {
  const docker = getDocker(config);
  await docker
    .getContainer(containerId)
    .remove({ force: true })
    .catch(() => {});
  lastActivityByContainer.delete(containerId);
  commandCountByContainer.delete(containerId);
}

// Idle/lifetime reaper: catches task containers a crashed or misbehaving
// n8n execution never explicitly destroyed. This is a real, new leak risk
// that didn't exist in the old one-shot model, where every container's
// entire lifetime was exactly one shell script's runtime.
export function startTaskContainerReaper(config: Config): NodeJS.Timeout {
  const docker = getDocker(config);
  return setInterval(async () => {
    let containers;
    try {
      containers = await docker.listContainers({ all: true, filters: { label: [TASK_LABEL_KEY] } });
    } catch (e) {
      console.error("task container reaper: failed to list containers:", e);
      return;
    }

    const now = Date.now();
    for (const info of containers) {
      const createdAt = Number(info.Labels?.[TASK_CREATED_AT_LABEL_KEY] ?? 0);
      const taskId = info.Labels?.[TASK_LABEL_KEY];
      const lastActivity = lastActivityByContainer.get(info.Id) ?? createdAt;

      const ageMs = now - createdAt;
      const idleMs = now - lastActivity;

      const pastMaxLifetime = createdAt > 0 && ageMs > config.taskContainerMaxLifetimeSeconds * 1000;
      const pastIdleTimeout = idleMs > config.taskContainerIdleTimeoutSeconds * 1000;

      if (pastMaxLifetime || pastIdleTimeout) {
        console.warn(
          `task container reaper: removing container ${info.Id} (task ${taskId}) - ` +
            `${pastMaxLifetime ? "past max lifetime" : "idle timeout"} ` +
            `(ageMs=${ageMs}, idleMs=${idleMs})`,
        );
        await destroyTaskContainer(config, info.Id).catch((e) =>
          console.error(`task container reaper: failed to remove ${info.Id}:`, e),
        );
      }
    }
  }, config.reaperIntervalSeconds * 1000);
}
