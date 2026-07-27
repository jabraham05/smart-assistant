import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { registerMemoryRecall } from "./tools/memory-recall.js";
import { registerWeatherGet } from "./tools/weather-get.js";
import { registerSkillPropose } from "./tools/skill-propose.js";
import { registerCalendarEvent } from "./tools/calendar-event.js";
import { registerCodeTask } from "./tools/code-task.js";
import { registerSpotifyControl } from "./tools/spotify-control.js";

export interface RequestContext {
  // The n8n Chat workflow's session id, threaded in via the MCP Client
  // Tool node's endpointUrl query string (?chatSessionId=...) — the
  // model has no reliable way to know or copy a session UUID itself, so
  // this is captured at the transport layer instead. Undefined for
  // CLI-triggered calls and any direct MCP client with no session to
  // report back to.
  chatSessionId?: string;
}

export function createServer(config: Config, context: RequestContext = {}): McpServer {
  const server = new McpServer({ name: "skills-mcp", version: "1.0.0" });
  registerMemoryRecall(server, config);
  registerWeatherGet(server, config);
  registerSkillPropose(server, config);
  registerCalendarEvent(server, config);
  registerCodeTask(server, config, context.chatSessionId);
  registerSpotifyControl(server, config);
  return server;
}
