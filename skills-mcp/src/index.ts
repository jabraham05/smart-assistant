import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig(process.env);

const app = express();
app.use(express.json());

// Stateless mode: a fresh McpServer + transport per request, no session
// tracking. This is the simplest spec-compliant shape for an internal-only
// service reached over a docker network with no load-balancer/session-
// affinity concerns.
app.post("/mcp", async (req, res) => {
  try {
    const server = createServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("Error handling MCP request:", e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless servers don't support the GET (server-initiated SSE stream) or
// DELETE (session termination) parts of the spec.
app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed (stateless server)" });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed (stateless server)" });
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`skills-mcp listening on :${config.port}`);
});
