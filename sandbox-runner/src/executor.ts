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
