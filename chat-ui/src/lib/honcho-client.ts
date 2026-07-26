import type { HonchoMessage, HonchoSession } from "@/types/chat";

// Server-side only: the API key never reaches the browser.
const HONCHO_API_KEY = process.env.HONCHO_API_KEY;
const HONCHO_WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? "smart-assistant";
const HONCHO_BASE_URL = "https://api.honcho.dev/v3";

function requireApiKey(): string {
  if (!HONCHO_API_KEY) {
    throw new Error("HONCHO_API_KEY is not configured");
  }
  return HONCHO_API_KEY;
}

async function honchoPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${HONCHO_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Honcho request to ${path} failed with ${res.status}`);
  }

  return res.json();
}

export async function listSessions(): Promise<HonchoSession[]> {
  const data = await honchoPost<{ items: HonchoSession[] }>(
    `/workspaces/${HONCHO_WORKSPACE_ID}/sessions/list`,
    { filters: {} }
  );
  return data.items;
}

export async function getSessionMessages(sessionId: string): Promise<HonchoMessage[]> {
  const data = await honchoPost<{ items: HonchoMessage[] }>(
    `/workspaces/${HONCHO_WORKSPACE_ID}/sessions/${sessionId}/messages/list`,
    {}
  );
  return data.items;
}
