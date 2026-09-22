import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Same connection pattern already proven in
// scripts/verify-tool-schema-compat.mjs: a real MCP client talking to
// skills-mcp's actual tools/list, not a hand-maintained list.
const SKILLS_MCP_URL = process.env.SKILLS_MCP_URL ?? "http://skills-mcp:3001/mcp";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export async function listMcpTools(): Promise<McpToolInfo[]> {
  const transport = new StreamableHTTPClientTransport(new URL(SKILLS_MCP_URL));
  const client = new Client({ name: "dashboard", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  } finally {
    await client.close();
  }
}
