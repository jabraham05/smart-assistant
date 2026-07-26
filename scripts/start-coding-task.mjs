#!/usr/bin/env node
// Explicit/manual trigger for the coding_task_pipeline workflow — this is
// the primary way to kick off a coding task, not the reactive code_task
// MCP tool (see README's coding-agent section for why: a coding task is
// an even more "reflective" decision than skill_propose, which this
// project's own evidence shows qwen3:8b already under-invokes).
//
// Usage: node scripts/start-coding-task.mjs <repoUrl> <task...>
//   [--ref=<branch>] [--test-command="<command>"]
//
// Requires N8N_CODING_TASK_WEBHOOK_URL to be set to the coding_task_pipeline
// workflow's webhook Production URL (host-reachable form, e.g.
// http://localhost:5678/webhook/coding-task — kept separate from
// skills-mcp's internal CODING_TASK_WEBHOOK_URL, same pattern as
// N8N_CHAT_WEBHOOK_URL vs chat-ui's internal N8N_WEBHOOK_URL).

const webhookUrl = process.env.N8N_CODING_TASK_WEBHOOK_URL;
if (!webhookUrl) {
  console.error("Set N8N_CODING_TASK_WEBHOOK_URL to the coding_task_pipeline webhook's Production URL");
  process.exit(1);
}

const args = process.argv.slice(2);
let ref;
let testCommand;
const positional = [];
for (const arg of args) {
  if (arg.startsWith("--ref=")) {
    ref = arg.slice("--ref=".length);
  } else if (arg.startsWith("--test-command=")) {
    testCommand = arg.slice("--test-command=".length);
  } else {
    positional.push(arg);
  }
}

const [repoUrl, ...taskWords] = positional;
const task = taskWords.join(" ");

if (!repoUrl || !task) {
  console.error(
    'Usage: node scripts/start-coding-task.mjs <repoUrl> <task...> [--ref=<branch>] [--test-command="<command>"]',
  );
  process.exit(1);
}

const body = { repoUrl, task, ...(ref ? { ref } : {}), ...(testCommand ? { testCommand } : {}) };

const res = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error(`Request failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

console.log("Task started. Check the coding_proposals Data Table for the result once it's done.");
