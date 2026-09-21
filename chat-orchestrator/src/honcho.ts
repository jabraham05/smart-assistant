import type { Config } from "./config.js";

const HONCHO_BASE_URL = "https://api.honcho.dev/v3";

// Ported verbatim from the n8n Chat workflow's Honcho HTTP Request nodes -
// same workspace, same endpoints, same payload shapes. Deliberately
// unaffected by the test/prod DB_SCHEMA split (see config.ts) - both
// chat-orchestrator instances share one real Honcho workspace, a known,
// accepted limitation for this phase (see the plan's "what's explicitly
// not changing" section).

function authHeaders(config: Config): Record<string, string> {
  return {
    Authorization: `Bearer ${config.honchoApiKey}`,
    "Content-Type": "application/json",
  };
}

function workspaceUrl(config: Config, path: string): string {
  return `${HONCHO_BASE_URL}/workspaces/${config.honchoWorkspaceId}${path}`;
}

// All Honcho calls here mirror the old workflow's onError:
// continueRegularOutput behavior - a briefly-unreachable Honcho degrades
// the system prompt (missing peer cards) rather than breaking the chat, so
// every function here swallows its own errors and returns a safe fallback.

export async function ensureSessionExists(config: Config, sessionId: string): Promise<void> {
  await fetch(workspaceUrl(config, "/sessions"), {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ id: sessionId }),
  }).catch((e) => console.error("honcho ensureSessionExists failed:", e));
}

export async function setUserObserveConfig(config: Config, sessionId: string): Promise<void> {
  await fetch(workspaceUrl(config, `/sessions/${sessionId}/peers/user/config`), {
    method: "PUT",
    headers: authHeaders(config),
    body: JSON.stringify({ observe_others: true }),
  }).catch((e) => console.error("honcho setUserObserveConfig failed:", e));
}

async function getPeerCard(config: Config, path: string): Promise<string[]> {
  try {
    const res = await fetch(workspaceUrl(config, path), { headers: authHeaders(config) });
    if (!res.ok) return [];
    const data = (await res.json()) as { peer_card?: string[] };
    return data.peer_card ?? [];
  } catch (e) {
    console.error(`honcho getPeerCard(${path}) failed:`, e);
    return [];
  }
}

export function getUserCard(config: Config): Promise<string[]> {
  return getPeerCard(config, "/peers/user/card");
}

export function getUserCardForAmy(config: Config): Promise<string[]> {
  return getPeerCard(config, "/peers/user/card?target=amy");
}

export async function storeTurn(
  config: Config,
  sessionId: string,
  userMessage: string,
  amyMessage: string,
): Promise<void> {
  await fetch(workspaceUrl(config, `/sessions/${sessionId}/messages`), {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({
      messages: [
        { content: userMessage, peer_id: "user" },
        { content: amyMessage, peer_id: "amy" },
      ],
    }),
  }).catch((e) => console.error("honcho storeTurn failed:", e));
}
