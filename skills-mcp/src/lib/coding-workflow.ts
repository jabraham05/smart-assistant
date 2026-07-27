import type { Config } from "../config.js";

export interface CodingTaskRequest {
  task: string;
  repoUrl: string;
  ref?: string;
  testCommand?: string;
  contextCommand?: string;
  // The chat session this task was triggered from, if any — captured at
  // the MCP transport layer (see server.ts's RequestContext), not
  // supplied by the model. Lets the pipeline post a real follow-up back
  // into the same conversation once it finishes.
  chatSessionId?: string;
}

// POSTs to the coding_task_pipeline n8n workflow's webhook. That webhook's
// trigger uses responseMode "onReceived" (see the workflow's own notes) -
// it responds within roughly a tenth of a second, before Planner/Coder/
// the sandbox/anything else has run, so this genuinely is fire-and-forget
// despite awaiting the fetch. Mirrors the fetch-wrapper shape of
// skills-workflow.ts's submitSkillProposal.
export async function submitCodingTask(config: Config, payload: CodingTaskRequest): Promise<void> {
  if (!config.codingTaskWebhookUrl) {
    throw new Error("CODING_TASK_WEBHOOK_URL is not configured");
  }

  const res = await fetch(config.codingTaskWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Coding task intake failed: ${res.status} ${body}`);
  }
}
