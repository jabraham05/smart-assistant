import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { listProjects, listResearchQueue, type ProjectListItem } from "../lib/knowledge-engine-client.js";
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

// Real gap found via live testing: neither research_task_status nor this
// tool ever had a next-step field for pending/researching work, so the
// model invented "waiting for you" framing when asked what the next step
// was - there was genuinely nothing for the user to do, since the queue
// drains automatically (event-bus's periodic drain). Same string
// duplicated in research-task-status.ts rather than a shared module for
// two call sites.
const RESEARCH_IN_PROGRESS_NOTE = "no action needed - runs automatically in the background and will complete without further input";
const IN_PROGRESS_STATUSES = ["pending", "researching", "running"];

// Real bug found via live testing: returning a nested object with
// separate id/status/activityType/progress fields per item just got
// relayed back to the user as a bulleted enumeration of raw field names -
// the same "wall of raw data" failure research_task_status already hit
// once, and telling the model to "summarize, don't dump" in the tool
// description alone didn't stop it recurring here either. Formatting an
// already-readable line per item here removes the temptation to restate
// fields verbatim - the model's job becomes relaying/condensing already-
// organized text, not manually flattening a JSON tree.
//
// Also fixes a real, separate bug from the same live session: goals,
// projects, task_contexts, and coding_tasks are four independent tables,
// each with their own numeric id sequence - "ID 8" is ambiguous across
// all four. The model conflated an abandoned goal #8 with an unrelated
// active project #8 that happened to share the number, because nothing
// ever labeled which table an id belonged to. Every id here is prefixed
// with its type ("project #8", not bare "8" or "ID 8") - same fix applied
// to goal_manage/task_context_manage's own list output.
function formatProjectLine(p: ProjectListItem): string {
  const progress = p.activity_type === "coding" ? p.coding_task_status : p.research_queue_status;
  const parts = [`project #${p.id} "${p.title}" - ${p.status} (${p.activity_type})`];
  if (progress) parts.push(`progress: ${progress}`);
  if (p.activity_type === "research" && p.research_queue_status && IN_PROGRESS_STATUSES.includes(p.research_queue_status)) {
    parts.push(RESEARCH_IN_PROGRESS_NOTE);
  }
  if (p.coding_task_pr_url) parts.push(`PR: ${p.coding_task_pr_url}`);
  return `- ${parts.join(", ")}`;
}

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
        "errands) - those are unrelated to research or coding work. The result is already a short, " +
        "organized plain-text summary - relay it in your own words as a few sentences or a short " +
        "list, don't restate every line verbatim, and don't call this again just to double-check " +
        "something it already answered.",
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

        const sections: string[] = [];

        if (projects.length > 0) {
          const shown = projects.slice(0, MAX_ITEMS_PER_SECTION);
          sections.push(`Projects (${shown.length}${projects.length > shown.length ? ` of ${projects.length}` : ""}):\n${shown.map(formatProjectLine).join("\n")}`);
        }

        if (codingTasks.length > 0) {
          sections.push(
            `Recent coding tasks (${codingTasks.length}):\n${codingTasks
              .map((t) => {
                // "approve_partial" means real, working code for a
                // smaller scope than what was asked, honestly disclosed -
                // reviewer_reason is the Reviewer's own account of what's
                // missing/reduced, and needs to reach the user here just
                // as much as a failure reason does, not just on the
                // failure path.
                const showsReason =
                  (t.status === "needs_review_failed" || t.reviewer_verdict === "approve_partial") &&
                  t.reviewer_reason;
                const statusLabel = t.reviewer_verdict === "approve_partial" ? `${t.status} (partial)` : t.status;
                return `- coding task #${t.id} "${t.task_description}" - ${statusLabel}${
                  showsReason ? `, reason: ${t.reviewer_reason}` : ""
                }${t.pr_url ? `, PR: ${t.pr_url}` : ""}`;
              })
              .join("\n")}`,
          );
        }

        if (researchQueue.length > 0) {
          sections.push(
            `Recent research queue entries (${researchQueue.length}):\n${researchQueue
              .map(
                (r) =>
                  `- research #${r.id} "${r.topic}" - ${r.status}${IN_PROGRESS_STATUSES.includes(r.status) ? `, ${RESEARCH_IN_PROGRESS_NOTE}` : ""}`,
              )
              .join("\n")}`,
          );
        }

        return textResult(sections.join("\n\n"));
      } catch (e) {
        return errorResult(`status_overview failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
