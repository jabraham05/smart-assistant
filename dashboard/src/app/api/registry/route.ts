import { NextResponse } from "next/server";
import { listMcpTools } from "@/lib/mcp-tools-client";
import { getCapabilityGroups } from "@/lib/n8n-groups";

// coding-orchestrator has no dynamic discovery mechanism - these 4 roles
// are just hardcoded functions in coding-orchestrator/src/pipeline.ts
// (callPlanner, runCoderRound, runTesterRound, callReviewer). Update this
// list by hand if that pipeline's roles ever change.
const CODING_ORCHESTRATOR_ROLES = [
  { name: "Planner", source: "callPlanner", description: "Breaks a coding task into a concrete plan before any code is written." },
  { name: "Coder", source: "runCoderRound", description: "Writes/edits code for one round of the task, following the Planner's plan." },
  { name: "Tester", source: "runTesterRound", description: "Runs and evaluates tests against the Coder's changes." },
  { name: "Reviewer", source: "callReviewer", description: "Reviews the final diff before it's considered done." },
] as const;

export async function GET() {
  const [mcpToolsResult, groupsResult] = await Promise.allSettled([listMcpTools(), getCapabilityGroups()]);

  return NextResponse.json({
    mcpTools: mcpToolsResult.status === "fulfilled" ? mcpToolsResult.value : { error: mcpToolsResult.reason?.message ?? String(mcpToolsResult.reason) },
    capabilityGroups: groupsResult.status === "fulfilled" ? groupsResult.value : { error: groupsResult.reason?.message ?? String(groupsResult.reason) },
    codingOrchestratorRoles: CODING_ORCHESTRATOR_ROLES,
  });
}
