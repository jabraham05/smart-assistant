// Thin client for openhands-runner's task API (Phase 2 of the
// infrastructure rebuild - see openhands-runner/src/main.py for the actual
// request/response shapes this mirrors). Unlike sandbox-client.ts, there's
// no separate create/exec/destroy container lifecycle to drive here -
// openhands-runner's DockerWorkspace owns its own container for the
// duration of a single /run-task or /propose-pr call.

export interface RunTaskRequest {
  taskId: number;
  taskDescription: string;
  repoUrl: string;
  ref: string;
  testCommand: string;
}

export interface RunTaskResult {
  diff: string;
  testExitCode: number;
  testOutput: string;
  success: boolean;
  summary: string;
  attempts: number;
}

export interface ProposePrResult {
  pushed: boolean;
  prUrl?: string;
  error?: string;
}

async function request<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
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
      throw new Error(message);
    }

    return body as T;
  } finally {
    clearTimeout(timeout);
  }
}

// No fixed timeout ceiling worth guessing here - a real coding task
// (clone + agent loop + up to openhands-runner's own MAX_ATTEMPTS internal
// retries, each running the project's test command) can legitimately take
// several minutes. 20 minutes matches this project's existing coder/tester
// iteration budgets in spirit without being a tight guess dressed up as a
// real number.
export function runTask(openhandsRunnerUrl: string, req: RunTaskRequest): Promise<RunTaskResult> {
  return request(`${openhandsRunnerUrl}/run-task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    timeoutMs: 20 * 60_000,
  });
}

export function proposePr(
  openhandsRunnerUrl: string,
  opts: { repoUrl: string; ref?: string; branchName: string; diff: string; prTitle: string; prBody?: string },
): Promise<ProposePrResult> {
  return request(`${openhandsRunnerUrl}/propose-pr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
    timeoutMs: 60_000,
  });
}
