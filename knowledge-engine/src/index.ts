import express from "express";
import { loadConfig } from "./config.js";
import { checkSchema } from "./db.js";
import { ingestText } from "./engine/ingest.js";

const config = loadConfig(process.env);

const app = express();
app.use(express.json({ limit: "10mb" }));

// Phase 0 checkpoint: proves the service connects to the real `research`
// database and the tables from 08-create-knowledge-tables.sql exist, not
// just that the process started.
app.get("/health", async (_req, res) => {
  try {
    const schema = await checkSchema(config);
    res.json(schema);
  } catch (e) {
    console.error("health check failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /documents/ingest - direct knowledge ingestion (remember()). Phase
// 1a: text/URL only, PDF comes in Phase 1b via scripts/ingest-document.mjs.
app.post("/documents/ingest", async (req, res) => {
  const body = req.body as {
    sourceType?: "text" | "url";
    text?: string;
    url?: string;
    title?: string;
    domain?: string;
    metadata?: Record<string, unknown>;
    triggerSource?: string;
    originSessionId?: string;
  };

  if (body.sourceType !== "text" && body.sourceType !== "url") {
    return res.status(400).json({ error: "sourceType must be 'text' or 'url'" });
  }

  try {
    const result = await ingestText(config, {
      sourceType: body.sourceType,
      text: body.text,
      url: body.url,
      title: body.title,
      domain: body.domain,
      metadata: body.metadata,
      triggerSource: body.triggerSource,
      originSessionId: body.originSessionId,
    });
    res.status(201).json(result);
  } catch (e) {
    console.error("failed to ingest document:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`knowledge-engine listening on :${config.port}`);
});
