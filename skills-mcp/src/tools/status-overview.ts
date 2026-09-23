import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { listProjects, listResearchQueue } from "../lib/knowledge-engine-client.js";
import { listCodingTasks } from "../lib/coding-orchestrator-client.js";
import { errorResult, textResult } from "../types.js";

// Real gap found via live testing, twice over: asked broadly about
// progress across several concurrent interests, the model guessed one
// specific topic for research_task_status and answered narrowly; asked
// about coding tasks specifically, it had no way to list anything and
// fell back to task_context_manage(list) - a completely unrelated concept
// (generic personal reminders) - dumping mostly-abandoned reminders as if
// they answered the question. This exists because nothing ever exposed
// "what's in progress across everything" to chat, even though every piece
// of underlying data already had a list endpoint built for the /amy web
// dashboard (knowledge-engine's GET /projects, GET /research-queue;
// coding-orchestrator's GET /tasks). Deliberately doesn't cross-reference
// which coding tasks/queue entries are linked to a project - showing one
// twice (once under Projects, once under its own raw list) is harmless
// overlap, matching /amy's own Coding Tasks card precedent.
const MAX_ITEMS_PER_SECTION = 5;

// Same gap and same fix as research-task-status.ts's RESEARCH_IN_PROGRESS_NOTE
// (duplicated rather than shared for two call sites) - a research
// project/queue entry sitting at pending/researching has nothing for the
// user to do, but nothing here said so, so the model invented "waiting
// for you" framing when asked what the next step was.
const RESEARCH_IN_PROGRESS_NOTE =
  "no action needed - runs automatically in the background and will complete without further input";
const IN_PROGRESS_STATUSES = ["pending", "researching", "running"];

export function registerStatusOverview(server: McpServer, config: Config): void {
  server.registerTool(
    "status_overview",
    {
      title: "Overview of everything in progress",
      description:
        "Get a broad overview of everything currently in progress: proposed/active/done projects " +
        "(both research and coding activity types), recent coding tasks, and recent research queue " +
        "entries. Use this for a BROAD question like 'how's everything going' / 'what's in progress' " +
        "/ 'what are my coding tasks' - NOT for a specific thing you already have in mind. For one " +
        "specific research topic, use research_task_status with that topic instead. For the coding " +
        "task from THIS conversation specifically, use code_task_status instead. This tool has " +
        "nothing to do with task_context_manage's generic personal reminders (trip planning, " +
        "errands) - those are unrelated to research or coding work.",
      inputSchema: {},
    },
    async () => {
      try {
        const [projects, codingTasks, researchQueue] = await Promise.all([
          listProjects(config),
          listCodingTasks(config, MAX_ITEMS_PER_SECTION).catch(() => []),
          listResearchQueue(config, MAX_ITEMS_PER_SECTION).catch(() => []),
        ]);

        if (projects.length === 0 && codingTasks.length === 0 && researchQueue.length === 0) {
          return textResult("Nothing in progress right now - no projects, coding tasks, or research queue entries.");
        }

        return textResult({
          projects: projects.slice(0, MAX_ITEMS_PER_SECTION).map((p) => ({
            id: p.id,
            title: p.title,
            status: p.status,
            activityType: p.activity_type,
            progress: p.activity_type === "coding" ? p.coding_task_status : p.research_queue_status,
            prUrl: p.coding_task_pr_url ?? undefined,
            note:
              p.activity_type === "research" && p.research_queue_status && IN_PROGRESS_STATUSES.includes(p.research_queue_status)
                ? RESEARCH_IN_PROGRESS_NOTE
                : undefined,
          })),
          recentCodingTasks: codingTasks.map((t) => ({
            id: t.id,
            task: t.task_description,
            status: t.status,
            prUrl: t.pr_url ?? undefined,
          })),
          recentResearch: researchQueue.map((r) => ({
            id: r.id,
            topic: r.topic,
            status: r.status,
            note: IN_PROGRESS_STATUSES.includes(r.status) ? RESEARCH_IN_PROGRESS_NOTE : undefined,
          })),
        });
      } catch (e) {
        return errorResult(`status_overview failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
