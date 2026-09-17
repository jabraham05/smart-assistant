import express from "express";
import { loadConfig } from "./config.js";
import { checkSchema } from "./db.js";
import { ingestDocument } from "./engine/ingest.js";

const config = loadConfig(process.env);

const app = express();
// Generous limit: a base64-encoded PDF manual sent via /documents/ingest
// runs well past express's 100kb default (a real multi-hundred-page manual,
// base64-inflated ~33%, can land in the tens of MB).
app.use(express.json({ limit: "150mb" }));

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

// POST /documents/ingest - direct knowledge ingestion (remember()).
// text/url/pdf. Local-file PDF ingestion is CLI-only via
// scripts/ingest-document.mjs, since no upload channel exists in chat-ui.
app.post("/documents/ingest", async (req, res) => {
  const body = req.body as {
    sourceType?: "text" | "url" | "pdf";
    text?: string;
    url?: string;
    pdfBase64?: string;
    title?: string;
    domain?: string;
    metadata?: Record<string, unknown>;
    triggerSource?: string;
    originSessionId?: string;
  };

  if (body.sourceType !== "text" && body.sourceType !== "url" && body.sourceType !== "pdf") {
    return res.status(400).json({ error: "sourceType must be 'text', 'url', or 'pdf'" });
  }

  try {
    const result = await ingestDocument(config, {
      sourceType: body.sourceType,
      text: body.text,
      url: body.url,
      pdfBase64: body.pdfBase64,
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
