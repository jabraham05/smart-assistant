import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { listProjects, completeProject, type ProjectListItem } from "../lib/knowledge-engine-client.js";
import { errorResult, textResult } from "../types.js";

// Real gap found via live testing: once a project's underlying research/
// coding work finished ("ready to complete" on /amy), there was no way to
// actually finish it from chat - consolidation only ever existed as a
// dashboard button (POST /projects/:id/complete, already built). This is
// the chat equivalent, wrapping that same endpoint.
// Word-overlap match, not a literal substring check - real bug found via
// live testing: "the project about verifying project_complete chat tool"
// vs the actual title "Verify project_complete chat tool" share every
// significant word except "verify"/"verifying" (a word-form mismatch), so
// a substring check found nothing. Same lenient-matching spirit as
// knowledge-engine's lexeme-overlap topic lookups, done in plain JS here
// since this service has no direct SQL access to run that technique.
function normalizeWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

function findProjectByTopic(projects: ProjectListItem[], topic: string): ProjectListItem | undefined {
  const topicWords = normalizeWords(topic);
  if (topicWords.size === 0) return undefined;

  let best: { project: ProjectListItem; overlap: number } | undefined;
  for (const p of projects) {
    const titleWords = normalizeWords(p.title);
    const overlap = [...topicWords].filter((w) => titleWords.has(w)).length;
    if (overlap > 0 && (!best || overlap > best.overlap)) {
      best = { project: p, overlap };
    }
  }
  return best?.project;
}

export function registerProjectComplete(server: McpServer, config: Config): void {
  server.registerTool(
    "project_complete",
    {
      title: "Complete/consolidate a project",
      description:
        "Finish an active project once its research or coding work is actually done - synthesizes " +
        "the findings (or diff/reviewer verdict, for a coding project) into a real knowledge " +
        "document and marks the project done. Use when the user asks to finish, complete, wrap up, " +
        "or consolidate a project - e.g. after status_overview showed one as 'ready to complete'. " +
        "Pass projectId if you already know it (the number from a 'project #N' reference), or topic " +
        "to look it up by name instead - one of the two is required. If the underlying work isn't " +
        "finished yet, this returns a clear reason instead of completing (e.g. 'research not " +
        "finished yet', or a real coding failure reason) - relay that to the user honestly rather " +
        "than claiming it completed or retrying repeatedly.",
      inputSchema: {
        projectId: z.coerce.number().int().optional().describe("The project's id, e.g. '8' from a 'project #8' reference."),
        topic: z
          .string()
          .optional()
          .describe("The project's title/topic to look it up by, if you don't have its id."),
      },
    },
    async ({ projectId, topic }) => {
      try {
        let id = projectId;
        if (!id) {
          if (!topic?.trim()) return errorResult("Provide either projectId or topic.");
          const projects = await listProjects(config, "active");
          const match = findProjectByTopic(projects, topic);
          if (!match) return textResult(`No active project found matching "${topic}".`);
          id = match.id;
        }

        const result = await completeProject(config, id);
        if (!result.completed) {
          return textResult(`Couldn't complete project #${id}: ${result.reason}`);
        }
        return textResult(
          `Project #${id}${result.title ? ` ("${result.title}")` : ""} completed - findings consolidated into a knowledge document.`,
        );
      } catch (e) {
        return errorResult(`project_complete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
