import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { callDashboardControl } from "../lib/dashboard-control.js";
import { errorResult, textResult } from "../types.js";

function notConfiguredResult() {
  return errorResult("Dashboard control is not configured (DASHBOARD_CONTROL_WEBHOOK_URL not set).");
}

export function registerDashboardControl(server: McpServer, config: Config): void {
  server.registerTool(
    "dashboard_control",
    {
      title: "Dashboard control",
      description:
        "Control the smart-mirror dashboard's widget layout: get the current arrangement, " +
        "show or hide a widget, move it to a different position, or resize it, chosen via " +
        "the `action` parameter. Widgets are always the same width and centered as a group in " +
        "a single row (wrapping if needed) — only their left-to-right order and height vary. " +
        "Use action='get_layout' first whenever a relative change is requested (e.g. 'move " +
        "weather before the calendar') — never guess the current order. action='show' adds a " +
        "widget back to the dashboard, action='hide' removes it entirely (not just visually) " +
        "— a hidden widget stops appearing until shown again. action='move' and " +
        "action='resize' only work on a widget that's currently shown — check with " +
        "action='get_layout' or use action='show' first if it might be hidden.",
      inputSchema: {
        action: z
          .enum(["get_layout", "show", "hide", "move", "resize"])
          .describe("Which dashboard-layout operation to perform."),
        type: z
          .enum(["weather", "calendar", "spotify"])
          .optional()
          .describe("show/hide/move/resize: which widget type to act on. Required for all except 'get_layout'."),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("move: the new zero-based position in left-to-right display order."),
        h: z
          .number()
          .int()
          .min(1)
          .max(2)
          .optional()
          .describe("resize: 1 for normal height, 2 for taller (e.g. a calendar with several events). Widgets only ever get taller, never wider."),
      },
    },
    async ({ action, type, position, h }) => {
      if (!config.dashboardControlWebhookUrl) return notConfiguredResult();

      if (action !== "get_layout" && !type) {
        return errorResult(`type is required for action='${action}'.`);
      }
      if (action === "move" && position === undefined) {
        return errorResult("position is required for action='move'.");
      }
      if (action === "resize" && h === undefined) {
        return errorResult("h is required for action='resize'.");
      }

      try {
        const result = await callDashboardControl(config, { action, type, position, h });
        return textResult(result);
      } catch (e) {
        return errorResult(`dashboard_control failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
