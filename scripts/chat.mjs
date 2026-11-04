#!/usr/bin/env node
// Quick CLI to test connectivity to the chat webhook - either
// agent-service (what chat-ui/discord-bot actually use now, see
// docs/agent-service.md) or, for rollback testing, the old n8n Chat
// Trigger's Production URL. Both speak the identical NDJSON contract, so
// no code here needs to know which one it's talking to.
// Usage: node scripts/chat.mjs "your message here" [--user=<id>]
// Requires N8N_CHAT_WEBHOOK_URL, e.g.:
//   http://localhost:3010/webhook       (agent-service)
//   http://localhost:5678/webhook/...   (n8n Chat workflow, rollback path)
//
// --user/AMY_USER_ID picks which identity this turn is attributed to
// (agent-service's config.is_test_user) - defaults to "test" so ad-hoc
// runs of this script never accidentally write into a real profile.
// Pass --user=<your real id> (or set AMY_USER_ID) to talk to Amy as
// yourself instead.

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

const rawArgs = process.argv.slice(2);
const userArg = rawArgs.find((a) => a.startsWith("--user="));
const userId = userArg ? userArg.slice("--user=".length) : process.env.AMY_USER_ID || "test";
const message = rawArgs.filter((a) => !a.startsWith("--user=")).join(" ");
if (!message) {
  console.error("Usage: node scripts/chat.mjs <message> [--user=<id>]");
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
  body: JSON.stringify({ chatInput: message, sessionId, userId }),
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
