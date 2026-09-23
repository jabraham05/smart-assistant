import { Pool } from "pg";
import type { Config } from "./config.js";
import type { VerifiedFinding } from "./engine/verify.js";

export interface ResearchCompletionInfo {
  sessionId: number;
  topic: string;
  originSessionId?: string;
}

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

function buildSummary(topic: string, findings: VerifiedFinding[], failed: boolean): string {
  if (failed) {
    return `Research on "${topic}" didn't finish successfully - worth trying again or narrowing the topic.`;
  }
  if (findings.length === 0) {
    return `Finished researching "${topic}", but didn't turn up anything concrete enough to record.`;
  }
  const contested = findings.filter((f) => f.confidence === "contested").length;
  const contestedNote = contested > 0 ? ` (${contested} of them had conflicting sources)` : "";
  return `Finished researching "${topic}" - found ${findings.length} finding(s)${contestedNote}. Ask me about it and I'll pull up what I found.`;
}

// Posts a real follow-up back into the chat session a background research
// run was started from, once it reaches a terminal state - the direct
// replacement for research_pipeline's Notify Chat History / Notify Honcho
// nodes, and the same pattern coding-orchestrator's notify.ts already
// uses. Without this, research_task's "I'll post an update once it's
// done" would be a false promise, exactly the bug this project already
// found and fixed once for the coding-agent pipeline (see
// docs/coding-agent-pipeline.md's 2026-07-27 entry) - not repeating it
// here.
export async function notifyResearchComplete(
  config: Config,
  info: ResearchCompletionInfo,
  findings: VerifiedFinding[],
  failed: boolean,
): Promise<void> {
  const summary = buildSummary(info.topic, findings, failed);

  // Feeds the Home activity feed (see event-bus's activity.ts) - the
  // foreground counterpart to logAwaitingDigest's own publish below, so
  // "research done" shows up on Home whether or not the run was
  // background/deferred. Runs even with no origin_session_id (the direct
  // chat-reply notify below requires one, this doesn't).
  fetch(`${config.eventBusUrl}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "research",
      type: "research_completed",
      payload: { topic: info.topic, summary, failed },
      originSessionId: info.originSessionId,
    }),
  }).catch((e) => console.error(`notifyResearchComplete: failed to publish research_completed event for session ${info.sessionId}:`, e));

  if (!info.originSessionId) return;

  try {
    await getN8nPool(config).query(`INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2::jsonb)`, [
      `${info.originSessionId}__Postgres_Chat_Memory`,
      JSON.stringify({
        type: "ai",
        content: summary,
        tool_calls: [],
        additional_kwargs: {},
        response_metadata: {},
        invalid_tool_calls: [],
      }),
    ]);
  } catch (e) {
    console.error(`notifyResearchComplete: failed to write n8n_chat_histories for session ${info.sessionId}:`, e);
  }

  if (config.honchoApiKey) {
    try {
      const res = await fetch(
        `https://api.honcho.dev/v3/workspaces/${config.honchoWorkspaceId}/sessions/${info.originSessionId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.honchoApiKey}` },
          body: JSON.stringify({ messages: [{ content: summary, peer_id: "amy" }] }),
        },
      );
      if (!res.ok) {
        console.error(`notifyResearchComplete: Honcho notify failed for session ${info.sessionId}: ${res.status}`);
      }
    } catch (e) {
      console.error(`notifyResearchComplete: failed to notify Honcho for session ${info.sessionId}:`, e);
    }
  }
}

// Used instead of notifyResearchComplete when the triggering message
// classified background=true (see chat-orchestrator/classify-tools.ts) -
// a task explicitly started "for later" shouldn't ping the user the
// moment it happens to finish, possibly overnight. Logs an event instead
// for event-bus's /overnight-digest-check to pick up and deliver as one
// consolidated summary at the right time - see the architecture plan's
// Phase 1b.
export async function logAwaitingDigest(
  config: Config,
  info: ResearchCompletionInfo,
  findings: VerifiedFinding[],
  failed: boolean,
): Promise<void> {
  try {
    await fetch(`${config.eventBusUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "research",
        type: "research_completed_awaiting_digest",
        payload: { topic: info.topic, summary: buildSummary(info.topic, findings, failed), failed },
        originSessionId: info.originSessionId,
      }),
    });
  } catch (e) {
    console.error(`logAwaitingDigest: failed to publish event for session ${info.sessionId}:`, e);
  }
}
