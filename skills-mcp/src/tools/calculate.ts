import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateExpression } from "../lib/calculator.js";
import { errorResult, textResult } from "../types.js";

export function registerCalculate(server: McpServer): void {
  server.registerTool(
    "calculate",
    {
      title: "Calculate",
      description:
        "Evaluate a mathematical expression exactly and deterministically - addition, subtraction, " +
        "multiplication, division, exponents (^), percentages (e.g. '18%' means 0.18), and " +
        "parentheses. ALWAYS use this tool for ANY arithmetic, no matter how simple it looks - never " +
        "compute a numeric result yourself, not even a single simple operation. There is no such " +
        "thing as 'too trivial to bother' - language models (including you) are not reliable at " +
        "arithmetic, and that unreliability applies to simple-looking calculations too, not just " +
        "complex ones. Getting a real number wrong (a body-fat calculation, a calorie target, a " +
        "budget) can genuinely mislead the user. Pass one self-contained expression, e.g. " +
        "'160 * 0.18' or '131.2 / (1 - 0.10)' or '160 * (1 - 18%)'. For a multi-step problem, either " +
        "write it as one expression or call this multiple times, once per step - never finish the " +
        "last step in your head.",
      inputSchema: {
        expression: z
          .string()
          .min(1)
          .max(200)
          .describe("A single self-contained math expression to evaluate, e.g. '160 * (1 - 0.18)'."),
      },
    },
    async ({ expression }) => {
      try {
        const result = evaluateExpression(expression);
        return textResult({ expression, result });
      } catch (e) {
        return errorResult(`calculate failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
