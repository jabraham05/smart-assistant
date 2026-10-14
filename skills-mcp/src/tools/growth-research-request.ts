import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { errorResult, textResult } from "../types.js";

export function registerGrowthResearchRequest(server: McpServer, config: Config, sessionId?: string): void {
  server.registerTool(
    "growth_research_request",
    {
      title: "Ask Growth to plan research",
      description:
        "Submit an explicit user request for substantial research to Growth. Growth records and " +
        "promotes the approved request, its Planner scopes the brief, and the separate Research agent " +
        "does the research and creates or updates the knowledge document. This does not perform the " +
        "research itself. Use only when the user explicitly asks for in-depth research to be saved; " +
        "for immediate questions use knowledge_lookup.",
      inputSchema: {
        topic: z.string().min(1).describe("The research topic, preferably phrased as the user's requested outcome."),
      },
    },
    async ({ topic }) => {
      try {
        const response = await fetch(`${config.agentServiceUrl}/growth/research-requests`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic, sessionId }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = (await response.json().catch(() => ({}))) as { accepted?: boolean; opportunityId?: number; status?: string; error?: string };
        if (!response.ok || !body.accepted) {
          return errorResult(`Growth did not accept the research request: ${body.error ?? response.statusText}`);
        }
        return textResult({
          accepted: true,
          opportunityId: body.opportunityId,
          status: body.status,
          message: "Growth accepted the request. Its Planner will scope the brief before the Research agent starts.",
        });
      } catch (e) {
        return errorResult(`Growth research request failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
