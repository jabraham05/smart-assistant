import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { registerMemoryRecall } from "./tools/memory-recall.js";
import { registerWeatherGet } from "./tools/weather-get.js";
import { registerSkillPropose } from "./tools/skill-propose.js";
import { registerCalendarEvent } from "./tools/calendar-event.js";
import { registerCodeTask } from "./tools/code-task.js";

export function createServer(config: Config): McpServer {
  const server = new McpServer({ name: "skills-mcp", version: "1.0.0" });
  registerMemoryRecall(server, config);
  registerWeatherGet(server, config);
  registerSkillPropose(server, config);
  registerCalendarEvent(server, config);
  registerCodeTask(server, config);
  return server;
}
