import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { registerMemoryRecall } from "./tools/memory-recall.js";
import { registerWeatherGet } from "./tools/weather-get.js";
import { registerSkillPropose } from "./tools/skill-propose.js";
import { registerCalendarEvent } from "./tools/calendar-event.js";
import { registerCodeTask } from "./tools/code-task.js";
import { registerCodeTaskRunCommand } from "./tools/code-task-run-command.js";
import { registerCodeTaskGetDiff } from "./tools/code-task-get-diff.js";
import { registerCodeTaskWriteFile } from "./tools/code-task-write-file.js";
import { registerCodeTaskStatus } from "./tools/code-task-status.js";
import { registerSpotifyControl } from "./tools/spotify-control.js";
import { registerDashboardControl } from "./tools/dashboard-control.js";
import { registerWebSearch } from "./tools/web-search.js";
import { registerResearchTask } from "./tools/research-task.js";
import { registerResearchTaskStatus } from "./tools/research-task-status.js";
import { registerKnowledgeSearch } from "./tools/knowledge-search.js";
import { registerKnowledgeIngest } from "./tools/knowledge-ingest.js";
import { registerGoalManage } from "./tools/goal-manage.js";
import { registerTaskContextManage } from "./tools/task-context-manage.js";
import { registerProjectPropose } from "./tools/project-propose.js";
import { registerStatusOverview } from "./tools/status-overview.js";
import { registerProjectComplete } from "./tools/project-complete.js";
import { registerCalculate } from "./tools/calculate.js";
import { registerGrowthReview } from "./tools/growth-review.js";

export interface RequestContext {
  // The n8n Chat workflow's session id, threaded in via the MCP Client
  // Tool node's endpointUrl query string (?chatSessionId=...) — the
  // model has no reliable way to know or copy a session UUID itself, so
  // this is captured at the transport layer instead. Undefined for
  // CLI-triggered calls and any direct MCP client with no session to
  // report back to.
  chatSessionId?: string;
  // The coding_task_pipeline workflow's own MCP Client Tool node templates
  // these into its endpointUrl the same way (?taskContainerId=...&
  // taskWorkingDir=...), fixed for the whole agent run — never a tool
  // input-schema field, so the model can't choose or override which
  // container it talks to.
  taskContainerId?: string;
  taskWorkingDir?: string;
  // Threaded the same way as chatSessionId (?background=true) - set when
  // the triggering chat message classified background=true, so
  // research_task can defer its completion notify into the overnight
  // digest queue instead of pinging the session immediately.
  background?: boolean;
}

export function createServer(config: Config, context: RequestContext = {}): McpServer {
  const server = new McpServer({ name: "skills-mcp", version: "1.0.0" });
  registerMemoryRecall(server, config);
  registerWeatherGet(server, config);
  registerSkillPropose(server, config);
  registerCalendarEvent(server, config);
  registerCodeTask(server, config, context.chatSessionId);
  registerCodeTaskRunCommand(server, config, context.taskContainerId, context.taskWorkingDir);
  registerCodeTaskGetDiff(server, config, context.taskContainerId, context.taskWorkingDir);
  registerCodeTaskWriteFile(server, config, context.taskContainerId, context.taskWorkingDir);
  registerCodeTaskStatus(server, config, context.chatSessionId);
  registerSpotifyControl(server, config);
  registerDashboardControl(server, config);
  registerWebSearch(server, config);
  registerResearchTask(server, config, context.chatSessionId, context.background);
  registerResearchTaskStatus(server, config, context.chatSessionId);
  registerKnowledgeSearch(server, config);
  registerKnowledgeIngest(server, config);
  registerGoalManage(server, config, context.chatSessionId);
  registerTaskContextManage(server, config, context.chatSessionId);
  registerProjectPropose(server, config);
  registerStatusOverview(server, config);
  registerProjectComplete(server, config);
  registerCalculate(server, config);
  registerGrowthReview(server, config);
  return server;
}
