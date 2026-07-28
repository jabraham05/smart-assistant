import type { Config } from "../config.js";

export interface RunTaskCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// Thin fetch wrappers against sandbox-runner's persistent-task-container
// routes — same shape as coding-workflow.ts's submitCodingTask. containerId/
// workingDir are always supplied by the caller (the tool's registration-time
// context, never the model), never invented here.
export async function runTaskCommand(
  config: Config,
  params: { containerId: string; workingDir: string; command: string },
): Promise<RunTaskCommandResult> {
  const res = await fetch(`${config.sandboxRunnerUrl}/task/${params.containerId}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: params.command, workingDir: params.workingDir }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Task command execution failed: ${res.status} ${body}`);
  }

  return (await res.json()) as RunTaskCommandResult;
}

export async function getTaskDiff(
  config: Config,
  params: { containerId: string; workingDir: string },
): Promise<{ diff: string }> {
  const url = new URL(`${config.sandboxRunnerUrl}/task/${params.containerId}/diff`);
  url.searchParams.set("workingDir", params.workingDir);

  const res = await fetch(url.toString());

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Task diff fetch failed: ${res.status} ${body}`);
  }

  return (await res.json()) as { diff: string };
}
