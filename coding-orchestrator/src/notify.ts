import { Pool } from "pg";
import type { Config } from "./config.js";
import type { CodingTaskRow } from "./db.js";

let n8nPool: Pool | undefined;

function getN8nPool(config: Config): Pool {
  if (!n8nPool) {
    n8nPool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.n8nDatabase,
      user: config.postgres.user,
      password: config.postgres.password,
    });
  }
  return n8nPool;
}

function buildSummary(row: CodingTaskRow): string {
  if (row.status === "proposed" && row.pr_url) {
    return `Finished: ${row.task_description}. A pull request is ready for review: ${row.pr_url}`;
  }
  if (row.status === "proposed") {
    return `Finished: ${row.task_description}. A diff is ready for review.`;
  }
  if (row.status === "resource_limit_reached") {
    return (
      `Stopped early on: ${row.task_description}. The sandbox container hit its command limit ` +
      `before finishing - this needs a human to look at what's there so far.`
    );
  }
  return (
    `Didn't pass review after ${row.attempt_count} attempt(s): ${row.task_description}. ` +
    `${row.reviewer_reason || ""}`
  );
}

// Posts a follow-up message back into the same conversation the task was
// started from, once it reaches a terminal state - mirrors Notify Chat
// History / Notify Honcho's exact behavior from the old n8n workflow.
// Called from pipeline.ts's outermost `finally`, so this always runs
// (success or failure) whenever there's an origin session, instead of only
// on paths that happened to be wired through it.
export async function notifyOrigin(config: Config, row: CodingTaskRow): Promise<void> {
  if (!row.origin_session_id) return;

  const summary = buildSummary(row);

  try {
    await getN8nPool(config).query(
      `INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2::jsonb)`,
      [
        `${row.origin_session_id}__Postgres_Chat_Memory`,
        JSON.stringify({
          type: "ai",
          content: summary,
          tool_calls: [],
          additional_kwargs: {},
          response_metadata: {},
          invalid_tool_calls: [],
        }),
      ],
    );
  } catch (e) {
    console.error(`notifyOrigin: failed to write n8n_chat_histories for task ${row.id}:`, e);
  }

  if (!config.honchoApiKey) return;

  try {
    const res = await fetch(
      `https://api.honcho.dev/v3/workspaces/${config.honchoWorkspaceId}/sessions/${row.origin_session_id}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.honchoApiKey}`,
        },
        body: JSON.stringify({ messages: [{ content: summary, peer_id: "amy" }] }),
      },
    );
    if (!res.ok) {
      console.error(`notifyOrigin: Honcho notify failed for task ${row.id}: ${res.status}`);
    }
  } catch (e) {
    console.error(`notifyOrigin: failed to notify Honcho for task ${row.id}:`, e);
  }
}
