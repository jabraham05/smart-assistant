import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getSkillExamples } from "../db.js";
import { errorResult, textResult } from "../types.js";

// Skills v2's L4 on demand (agent-service/src/skills_discovery.py never
// injects level4_examples unconditionally - it's typically long, and the
// single-pass prompt assembly has no "drill into this skill further"
// mechanism). This tool IS that mechanism: when a skill's L1/L2 summary
// isn't enough to actually follow the procedure, call this for the
// worked examples instead of guessing.
export function registerSkillExamples(server: McpServer, config: Config): void {
  server.registerTool(
    "skill_examples",
    {
      title: "Get worked examples for an active skill",
      description:
        "Fetch detailed worked examples for one of your active skills, when its summary " +
        "instructions aren't enough to actually follow the procedure confidently. Pass the " +
        "exact skill name as shown in your skills catalog. Returns nothing if that skill has " +
        "no examples registered yet - that's not an error, just means none exist.",
      inputSchema: {
        skillName: z.string().describe("The exact name of the active skill, as shown in your skills catalog."),
      },
    },
    async ({ skillName }) => {
      try {
        const examples = await getSkillExamples(config, skillName);
        if (!examples) return textResult(`No examples registered for "${skillName}".`);
        return textResult(examples);
      } catch (e) {
        return errorResult(`skill_examples failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
