#!/usr/bin/env node
// Regression check for the 2026-09-20 "MCP tool-name prefix breaks qwen3:8b's
// tool-calling grammar" bug (docs/chat-workflow.md). That bug slipped through
// because every prior benchmark used hand-typed, stripped tool names instead
// of what n8n actually sends Ollama - this script closes that gap by deriving
// the real tool list and the real prefix from the actual live sources (the MCP
// server's own tools/list response, and the checked-in workflow's node name),
// then running it against a real, running model. Never hand-edit its output.
//
// Must run inside a container on assistant-net (skills-mcp has no published
// port): docker compose exec -T n8n node - < scripts/verify-tool-schema-compat.mjs -- --model=llama3.1:8b --reps=10
//
// Usage: --model=<name> --reps=<n> --node="MCP Client Tool" --workflow=<path>
// --node defaults to the real node name read from --workflow (the checked-in
// Chat workflow export), so this always reflects whatever is actually deployed.

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const rawArgs = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    })
);

const MCP_URL = process.env.SKILLS_MCP_URL || "http://skills-mcp:3001/mcp";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";
const WORKFLOW_PATH = rawArgs.workflow || new URL("../n8n/workflows/9YdYYhVGfsKgj4yz.json", import.meta.url);
const NODE_NAME_PARAM = rawArgs.node || readRealNodeName(WORKFLOW_PATH);
const model = rawArgs.model || "qwen3:8b";
const reps = Number(rawArgs.reps || 10);
const PROMPT = rawArgs.prompt || "What does my knowledge base say about brake fluid for the Cayman?";
const TARGET_TOOL = rawArgs.tool || "knowledge_search";

function readRealNodeName(workflowPath) {
  const data = JSON.parse(readFileSync(workflowPath, "utf8"));
  const node = data.nodes.find((n) => n.type === "@n8n/n8n-nodes-langchain.mcpClientTool");
  if (!node) throw new Error("No mcpClientTool node found in " + workflowPath);
  return node.name;
}

// Ported verbatim from n8n's own McpClientTool/utils.js (buildMcpToolName) -
// verified against the source inside the n8n container - so this can never
// silently diverge from what n8n itself actually sends.
const MAX_MCP_TOOL_NAME_LENGTH = 64;
function buildMcpToolName(serverName, toolName) {
  const sanitizedServerName = serverName.replace(/[^a-zA-Z0-9]/g, "_");
  const fullName = `${sanitizedServerName}_${toolName}`;
  if (fullName.length <= MAX_MCP_TOOL_NAME_LENGTH) return fullName;
  const maxPrefixLen = MAX_MCP_TOOL_NAME_LENGTH - toolName.length - 1;
  return maxPrefixLen > 0 ? `${sanitizedServerName.slice(0, maxPrefixLen)}_${toolName}` : toolName;
}

async function fetchRealTools() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "verify-tool-schema-compat", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => ({
    type: "function",
    function: {
      name: buildMcpToolName(NODE_NAME_PARAM, t.name),
      description: t.description ?? "",
      parameters: t.inputSchema,
    },
  }));
}

async function chat(messages, tools) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools, think: false, stream: false, options: { num_ctx: 16384 } }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const tools = await fetchRealTools();
const target = buildMcpToolName(NODE_NAME_PARAM, TARGET_TOOL);
console.log(`Node name: "${NODE_NAME_PARAM}" -> prefix "${target.slice(0, -TARGET_TOOL.length)}"`);
console.log(`Real tool count: ${tools.length}, longest name: ${Math.max(...tools.map((t) => t.function.name.length))} chars`);
console.log(`Model: ${model}, reps: ${reps}, target: ${target}\n`);

await chat([{ role: "user", content: "hi" }], tools); // warmup

let pass = 0, empty = 0, other = 0;
for (let i = 0; i < reps; i++) {
  const data = await chat([{ role: "user", content: PROMPT }], tools);
  const toolCalls = data.message?.tool_calls || [];
  const content = data.message?.content || "";
  if (toolCalls.some((c) => c.function?.name === target)) pass++;
  else if (!content.trim() && toolCalls.length === 0) empty++;
  else other++;
  console.log(`  rep ${i + 1}: ${toolCalls.map((c) => c.function?.name).join(",") || (content ? "no-tool-answered" : "EMPTY")}`);
}

console.log(`\n${model} vs real live tool schema: ${pass}/${reps} correct, ${empty}/${reps} empty, ${other}/${reps} other`);
if (pass < reps) {
  console.error("FAIL: does not reliably call the real tool with the real production schema.");
  process.exit(1);
}
console.log("PASS");
