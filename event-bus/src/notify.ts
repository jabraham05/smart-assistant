import { Pool } from "pg";
import type { Config } from "./config.js";

// Deliberately duplicated from coding-orchestrator/src/notify.ts rather
// than shared as a package - same convention this project already uses for
// small cross-service functions (see skills-mcp/src/routes/dashboard-data.ts's
// comment on duplicating the Pi's widget catalog). event-bus and
// coding-orchestrator are separate deployables with no shared package
// today; introducing one for a ~30-line function is more infrastructure
// than the duplication costs.

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

// Posts a message into an existing chat session - mirrors
// coding-orchestrator's notifyOrigin exactly, generalized to take a
// pre-built summary and session id directly instead of a CodingTaskRow.
export async function notifySession(config: Config, sessionId: string, summary: string): Promise<void> {
  try {
    await getN8nPool(config).query(
      `INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2::jsonb)`,
      [
        `${sessionId}__Postgres_Chat_Memory`,
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
    console.error(`notifySession: failed to write n8n_chat_histories for session ${sessionId}:`, e);
  }

  if (!config.honchoApiKey) return;

  try {
    const res = await fetch(
      `https://api.honcho.dev/v3/workspaces/${config.honchoWorkspaceId}/sessions/${sessionId}/messages`,
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
      console.error(`notifySession: Honcho notify failed for session ${sessionId}: ${res.status}`);
    }
  } catch (e) {
    console.error(`notifySession: failed to notify Honcho for session ${sessionId}:`, e);
  }
}
