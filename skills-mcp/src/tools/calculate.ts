import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { evaluateExpression } from "../lib/calculator.js";
import { resolveDate } from "../lib/date-resolve.js";
import { errorResult, textResult } from "../types.js";

// resolve_date lives on this tool, not a separate one, and not folded into
// calendar_event's own schema: this tool is unconditionally bound on every
// single turn regardless of tool-group classification (see
// classify-tools.ts's expandGroupsToTools - 'calculate' is always in the
// returned set), so a date question can never be silently dropped by a
// classifier miss the way a calendar_event-only fix would be. Also makes
// the fix available to any relative-date question at all, not just ones
// that happen to also touch the calendar.
export function registerCalculate(server: McpServer, config: Config): void {
  server.registerTool(
    "calculate",
    {
      title: "Calculate",
      description:
        "Deterministic computation the model should never try to do in its head - arithmetic " +
        "(action='evaluate') or relative date/time resolution (action='resolve_date'). ALWAYS use " +
        "this tool for ANY arithmetic, no matter how simple it looks, AND for ANY relative date/time " +
        "reference ('this Wednesday', 'next Friday', 'in 3 days', 'tomorrow morning') before writing " +
        "it into a reply or passing it to another tool (e.g. calendar_event's start/end) - never " +
        "compute either yourself. There is no such thing as 'too trivial to bother': language models " +
        "(including you) are not reliable at arithmetic OR at counting days/weekdays, and that applies " +
        "to simple-looking cases too, not just complex ones. Getting a number wrong (a body-fat " +
        "calculation, a budget) or a date wrong (scheduling the wrong day) can genuinely mislead the " +
        "user or create a real-world mistake.",
      inputSchema: {
        action: z.enum(["evaluate", "resolve_date"]).describe("Which kind of computation to perform."),
        expression: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "evaluate: a single self-contained math expression, e.g. '160 * (1 - 0.18)'. Supports " +
              "+ - * / ^ and percentages (e.g. '18%' means 0.18). For a multi-step problem, either " +
              "write it as one expression or call this multiple times, once per step - never finish " +
              "the last step in your head.",
          ),
        dateExpression: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "resolve_date: a natural-language relative date/time phrase, e.g. 'this Wednesday at " +
              "6pm', 'next Friday', 'in 3 days', 'tomorrow morning'. Always resolved against the " +
              "real current date - never guess or precompute this yourself.",
          ),
      },
    },
    async ({ action, expression, dateExpression }) => {
      if (action === "evaluate") {
        if (!expression?.trim()) return errorResult("expression is required for action='evaluate'.");
        try {
          const result = evaluateExpression(expression);
          return textResult({ expression, result });
        } catch (e) {
          return errorResult(`calculate failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // action === "resolve_date"
      if (!dateExpression?.trim()) return errorResult("dateExpression is required for action='resolve_date'.");
      const resolved = resolveDate(dateExpression, config.homeTimezone);
      if (!resolved) {
        return errorResult(
          `Could not resolve "${dateExpression}" to a date. Try rephrasing it (e.g. 'next Friday', 'in 3 days', 'tomorrow at 6pm').`,
        );
      }
      return textResult(resolved);
    },
  );
}
