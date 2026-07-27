import type { Config } from "../config.js";

export interface DashboardControlRequest {
  action: "get_layout" | "show" | "hide" | "move" | "resize";
  type?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface DashboardControlResult {
  widgets: Array<{ type: string; x: number; y: number; w: number; h: number }>;
  reasoning?: string;
  updatedAt: string;
}

// POSTs to the dashboard_control n8n workflow, which applies the change to
// the dashboard_state Data Table and pushes the result to the Pi. Mirrors
// the fetch-wrapper shape of lib/skills-workflow.ts's submitSkillProposal,
// but this one returns the resulting layout (the tool's actual return
// value) rather than being fire-and-forget.
export async function callDashboardControl(
  config: Config,
  request: DashboardControlRequest,
): Promise<DashboardControlResult> {
  const res = await fetch(config.dashboardControlWebhookUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dashboard control failed: ${res.status} ${body}`);
  }

  return (await res.json()) as DashboardControlResult;
}
