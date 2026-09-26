import type { Config } from "../config.js";

export interface CodingTaskRequest {
  task: string;
  // Omitted for a from-scratch task with no existing target repo — the
  // pipeline lands those in a shared coding_tasks repo instead (see
  // coding-orchestrator's own fallback-repo handling).
  repoUrl?: string;
  ref?: string;
  testCommand?: string;
  // No longer forwarded - real, live-verified finding: this was a
  // n8n-workflow-specific parameter for seeding the old hand-rolled
  // pipeline's Coder with initial file context. coding-orchestrator's own
  // pipeline doesn't need it - its Coder already has real shell access to
  // explore the repo itself (see pipeline.ts's agentTools/run_command).
  // Kept in the tool's own input schema for backward compatibility with
  // whatever a model might still send, just silently ignored now.
  contextCommand?: string;
  // The chat session this task was triggered from, if any — captured at
  // the MCP transport layer (see server.ts's RequestContext), not
  // supplied by the model. Lets the pipeline post a real follow-up back
  // into the same conversation once it finishes.
  chatSessionId?: string;
}

// Real, live-verified finding (2026-09-26): this used to POST to the old
// coding_task_pipeline n8n workflow's webhook (CODING_TASK_WEBHOOK_URL) -
// a shim that was never actually retired even after coding-orchestrator
// became the real pipeline owner months ago. When n8n's own database had a
// transient readiness issue, every code_task call failed outright with no
// coding_tasks row ever created and no reply reaching the user at all
// (the tool-call exception crashed the whole agent turn before any
// response was generated - reported live via Discord: "it never told me
// it started or anything"). coding-orchestrator's own POST /task has
// existed and worked reliably all session; this now calls it directly,
// same "retire the n8n hop, don't add a second one onto it" direction
// coding-orchestrator-client.ts's read-only caller already established.
export async function submitCodingTask(config: Config, payload: CodingTaskRequest): Promise<void> {
  const res = await fetch(`${config.codingOrchestratorUrl}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: payload.task,
      repoUrl: payload.repoUrl,
      ref: payload.ref,
      testCommand: payload.testCommand,
      chatSessionId: payload.chatSessionId,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Coding task intake failed: ${res.status} ${body}`);
  }
}

export interface CodingTaskStatus {
  found: boolean;
  status?: string;
  latestStatus?: string;
  attemptCount?: number;
  prUrl?: string;
  taskDescription?: string;
}

// Same n8n-shim retirement as submitCodingTask above - coding-orchestrator's
// own GET /task/status already returns this exact shape (found/status/
// latestStatus/attemptCount/prUrl/taskDescription), confirmed directly
// against its source (src/index.ts), so no shape translation is needed
// here at all.
export async function getCodingTaskStatus(config: Config, chatSessionId: string): Promise<CodingTaskStatus> {
  const url = new URL(`${config.codingOrchestratorUrl}/task/status`);
  url.searchParams.set("sessionId", chatSessionId);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Coding task status lookup failed: ${res.status} ${body}`);
  }

  return (await res.json()) as CodingTaskStatus;
}
