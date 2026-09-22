import type { Express } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../config.js";
import { createServer } from "../server.js";

export interface RegisteredTool {
  name: string;
  title: string;
  description: string;
}

// Plain internal REST route, no real chat session or MCP client involved -
// chat-ui's Agent Registry panel just wants to browse what's registered,
// same "plain internal REST route" pattern as dashboard-data.ts/
// spotify-action.ts/calendar-events.ts above. Reuses the SDK's own real
// tools/list handling (rather than reaching into McpServer's private
// tool-registration internals) by connecting a real MCP Client to a real
// McpServer over an in-memory transport pair - same process, no network
// hop, no chatSessionId needed since nothing here is ever actually called.
export function registerToolsRegistryRoute(app: Express, config: Config): void {
  app.get("/tools", async (_req, res) => {
    const server = createServer(config, {});
    const client = new Client({ name: "tools-registry-route", version: "1.0.0" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      const registered: RegisteredTool[] = tools.map((t) => ({
        name: t.name,
        title: t.title ?? t.name,
        description: t.description ?? "",
      }));
      res.json({ tools: registered });
    } catch (e) {
      console.error("Error listing tools for registry route:", e);
      res.status(500).json({ error: "failed to list tools" });
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
}
