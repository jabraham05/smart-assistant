#!/usr/bin/env node
// Explicit/manual trigger for knowledge-engine's document ingestion — the
// only way to ingest a local PDF today, since no file-upload channel exists
// in chat-ui (knowledge_ingest, the MCP tool, only accepts a URL). Mirrors
// scripts/start-coding-task.mjs's role as a reference CLI client.
//
// Usage: node scripts/ingest-document.mjs <path-to-pdf-or-text-file>
//   [--domain=<domain>] [--title="<title>"]
//
// Requires KNOWLEDGE_ENGINE_URL to be set to a host-reachable form of
// knowledge-engine's URL (e.g. http://localhost:3005 if published locally
// for this one-off script, since knowledge-engine has no published port by
// default - see docs/knowledge-engine.md).

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const engineUrl = process.env.KNOWLEDGE_ENGINE_URL;
if (!engineUrl) {
  console.error("Set KNOWLEDGE_ENGINE_URL to a host-reachable knowledge-engine URL");
  process.exit(1);
}

const args = process.argv.slice(2);
let domain;
let title;
const positional = [];
for (const arg of args) {
  if (arg.startsWith("--domain=")) {
    domain = arg.slice("--domain=".length);
  } else if (arg.startsWith("--title=")) {
    title = arg.slice("--title=".length);
  } else {
    positional.push(arg);
  }
}

const [filePath] = positional;
if (!filePath) {
  console.error('Usage: node scripts/ingest-document.mjs <path-to-pdf-or-text-file> [--domain=<domain>] [--title="<title>"]');
  process.exit(1);
}

const isPdf = extname(filePath).toLowerCase() === ".pdf";
const fileBuffer = await readFile(filePath);

const body = isPdf
  ? { sourceType: "pdf", pdfBase64: fileBuffer.toString("base64"), title, domain, triggerSource: "ingest_script" }
  : { sourceType: "text", text: fileBuffer.toString("utf8"), title, domain, triggerSource: "ingest_script" };

console.log(`Ingesting ${filePath} (${isPdf ? "pdf" : "text"}, ${fileBuffer.length} bytes)...`);

const res = await fetch(`${engineUrl}/documents/ingest`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error(`Request failed: ${res.status} ${res.statusText}`);
  console.error(await res.text());
  process.exit(1);
}

const result = await res.json();
console.log(`Ingested document ${result.documentId} (source ${result.sourceId}, ${result.chunkCount} chunks).`);
