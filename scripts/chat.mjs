#!/usr/bin/env node
// Quick CLI to test connectivity to the n8n chat webhook.
// Usage: node scripts/chat.mjs "your message here"
// Requires N8N_CHAT_WEBHOOK_URL to be set to the Chat Trigger node's Production URL.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionFile = join(__dirname, "..", ".chat-session-id");

const webhookUrl = process.env.N8N_CHAT_WEBHOOK_URL;
if (!webhookUrl) {
  console.error("Set N8N_CHAT_WEBHOOK_URL to the Chat Trigger node's Production URL");
  process.exit(1);
}

const message = process.argv.slice(2).join(" ");
if (!message) {
  console.error("Usage: node scripts/chat.mjs <message>");
  process.exit(1);
}

let sessionId;
if (existsSync(sessionFile)) {
  sessionId = readFileSync(sessionFile, "utf8").trim();
} else {
  sessionId = `cli-${Date.now()}`;
  writeFileSync(sessionFile, sessionId);
}

const res = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chatInput: message, sessionId }),
});

if (!res.ok || !res.body) {
  console.error(`Request failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

// Response Mode is "streaming": one JSON object per line (NDJSON), not a
// single JSON body. The AI Agent's "item" events carry the actual reply
// tokens; everything else (begin/end/error) just brackets tool calls.
function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return; // not a JSON line, ignore
  }
  if (event.type === "item" && event.metadata?.nodeName === "AI Agent" && event.content) {
    process.stdout.write(event.content);
  }
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) handleLine(line);
}
handleLine(buffer);
process.stdout.write("\n");
