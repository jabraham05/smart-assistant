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
        "show or hide a widget, move it to a different grid cell, or resize it, chosen via " +
        "the `action` parameter. Use action='get_layout' first whenever a relative change is " +
        "requested (e.g. 'move weather next to the calendar', 'make spotify bigger') — never " +
        "guess current coordinates. The grid is 4 columns wide; x/y are zero-based cell " +
        "coordinates and w/h are column/row spans; widgets should not overlap. action='show' " +
        "adds a widget back to the dashboard, action='hide' removes it entirely (not just " +
        "visually) — a hidden widget stops appearing until shown again. action='move' and " +
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
        x: z.number().int().min(0).optional().describe("move: the new zero-based column."),
        y: z.number().int().min(0).optional().describe("move: the new zero-based row."),
        w: z.number().int().min(1).optional().describe("resize: the new column span."),
        h: z.number().int().min(1).optional().describe("resize: the new row span."),
      },
    },
    async ({ action, type, x, y, w, h }) => {
      if (!config.dashboardControlWebhookUrl) return notConfiguredResult();

      if (action !== "get_layout" && !type) {
        return errorResult(`type is required for action='${action}'.`);
      }
      if (action === "move" && (x === undefined || y === undefined)) {
        return errorResult("x and y are required for action='move'.");
      }
      if (action === "resize" && (w === undefined || h === undefined)) {
        return errorResult("w and h are required for action='resize'.");
      }

      try {
        const result = await callDashboardControl(config, { action, type, x, y, w, h });
        return textResult(result);
      } catch (e) {
        return errorResult(`dashboard_control failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
