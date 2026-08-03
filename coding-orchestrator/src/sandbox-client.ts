// Thin client for sandbox-runner's persistent-task-container API. Every
// request shape here matches exactly what the old n8n workflow's
// httpRequest nodes already sent (Create Task Container / Extract Final
// Diff / Run Final Tests / Destroy Task Container / Propose PR) - the
// sandbox-runner contract itself doesn't change, only what calls it does.

export interface CreateContainerRequest {
  repoUrl?: string;
  ref?: string;
  projectFolder?: string;
  taskId: string;
  fallbackRepoUrl?: string;
  fallbackRef?: string;
  fallbackProjectFolder?: string;
}

export interface CreateContainerResult {
  containerId: string;
  workingDir: string;
  usedFallback: boolean;
  actualRepoUrl: string;
  actualProjectFolder: string;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ProposePrResult {
  pushed: boolean;
  prUrl?: string;
  error?: string;
  pushExitCode: number | null;
  pushStdout: string;
  pushStderr: string;
}

// Thrown when sandbox-runner refuses a call because the task's container
// has hit its lifetime command cap - a distinguishable, expected outcome
// (see README/plan: weak point #2), not a generic infrastructure failure.
// sandbox-runner returns this as a plain 500 with no distinct status code
// today; matched here by the exact message text until sandbox-runner is
// updated to return a dedicated status/error shape for it.
export class CommandLimitExceededError extends Error {}

export class TaskContainerNotFoundError extends Error {}

async function request<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 60_000);

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const bodyText = await res.text();
    let body: unknown;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = { error: bodyText };
    }

    if (!res.ok) {
      const message = (body as { error?: string }).error || `${res.status} ${bodyText}`;
      if (res.status === 404) {
        throw new TaskContainerNotFoundError(message);
      }
      if (res.status === 429) {
        throw new CommandLimitExceededError(message);
      }
      throw new Error(message);
    }

    return body as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function createContainer(
  sandboxRunnerUrl: string,
  req: CreateContainerRequest,
): Promise<CreateContainerResult> {
  return request(`${sandboxRunnerUrl}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    timeoutMs: 60_000,
  });
}

export function execInContainer(
  sandboxRunnerUrl: string,
  containerId: string,
  opts: { command: string; workingDir: string; timeoutSeconds?: number },
): Promise<ExecResult> {
  return request(`${sandboxRunnerUrl}/task/${containerId}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
    timeoutMs: (opts.timeoutSeconds ?? 30) * 1000 + 30_000,
  });
}

export function writeFileInContainer(
  sandboxRunnerUrl: string,
  containerId: string,
  opts: { filename: string; content: string; workingDir: string },
): Promise<{ written: boolean }> {
  return request(`${sandboxRunnerUrl}/task/${containerId}/write-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
    timeoutMs: 30_000,
  });
}

export function getDiff(
  sandboxRunnerUrl: string,
  containerId: string,
  workingDir: string,
): Promise<{ diff: string }> {
  const url = new URL(`${sandboxRunnerUrl}/task/${containerId}/diff`);
  url.searchParams.set("workingDir", workingDir);
  return request(url.toString(), { timeoutMs: 30_000 });
}

export function runTests(
  sandboxRunnerUrl: string,
  containerId: string,
  opts: { command: string; workingDir: string; timeoutSeconds?: number },
): Promise<ExecResult> {
  return execInContainer(sandboxRunnerUrl, containerId, {
    command: opts.command,
    workingDir: opts.workingDir,
    timeoutSeconds: opts.timeoutSeconds ?? 120,
  });
}

export async function destroyContainer(sandboxRunnerUrl: string, containerId: string): Promise<void> {
  await request(`${sandboxRunnerUrl}/task/${containerId}`, { method: "DELETE", timeoutMs: 30_000 });
}

export function proposePr(
  sandboxRunnerUrl: string,
  opts: {
    repoUrl: string;
    baseRef?: string;
    patch: string;
    branchName: string;
    commitMessage: string;
    prTitle: string;
    prBody?: string;
  },
): Promise<ProposePrResult> {
  return request(`${sandboxRunnerUrl}/propose-pr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
    timeoutMs: 60_000,
  });
}
