import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// A real MCP client against skills-mcp's existing /mcp endpoint - the
// direct replacement for n8n's MCP Client Tool node, which is what
// actually broke qwen3:8b's tool-calling (it prefixes tool names with its
// own node display name, silently breaking the model's tool-calling
// grammar once the combined name crosses ~5-6 segments; see
// docs/coding-agent-pipeline.md). Nothing about skills-mcp itself changes -
// it's already a correctly-separated, standalone MCP server; this is just
// a second, better-behaved consumer of it.

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class SkillsMcpClient {
  private client: Client;
  private connected = false;

  constructor(
    private readonly skillsMcpUrl: string,
    // Threaded into the endpoint URL as a query param, same correlation
    // mechanism the n8n MCP Client Tool node used
    // (?chatSessionId=...) - skills-mcp's RequestContext reads it at the
    // transport layer, not from a tool argument, so the model can't spoof
    // or omit it.
    private readonly chatSessionId: string,
    // Same correlation mechanism, threaded when this turn classified
    // background=true - lets research_task know to defer its completion
    // notify into the overnight digest queue instead of pinging the
    // session immediately (see skills-mcp/src/server.ts's RequestContext).
    private readonly background: boolean = false,
  ) {
    this.client = new Client({ name: "chat-orchestrator", version: "1.0.0" });
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    const url = new URL(`${this.skillsMcpUrl}/mcp`);
    url.searchParams.set("chatSessionId", this.chatSessionId);
    if (this.background) url.searchParams.set("background", "true");
    const transport = new StreamableHTTPClientTransport(url);
    await this.client.connect(transport);
    this.connected = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureConnected();
    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureConnected();
    const result = await this.client.callTool({ name, arguments: args });
    // skills-mcp's tools are all plain synchronous calls, never task-based,
    // so the "content" shape is the only one that should ever come back in
    // practice - this guard just keeps the type-checker honest about the
    // SDK's own union return type rather than asserting past it.
    if (!("content" in result)) {
      throw new Error(`tool "${name}" returned an unexpected task-based result shape`);
    }
    if (result.isError) {
      const text = extractText(result.content);
      throw new Error(text || `tool "${name}" returned an error`);
    }
    return extractText(result.content) || "(no output)";
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => !!c && typeof c === "object" && (c as { type?: string }).type === "text")
    .map((c) => c.text)
    .join("\n");
}
