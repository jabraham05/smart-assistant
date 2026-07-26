import type { Config } from "../config.js";

const HONCHO_BASE_URL = "https://api.honcho.dev/v3";

// Mirrors the previously-existing n8n HTTP Request Tool node's call to
// Honcho's dialectic chat endpoint (peer "user" answering questions about
// what's known of the user via long-term memory).
export async function honchoDialecticChat(config: Config, query: string): Promise<string> {
  const res = await fetch(
    `${HONCHO_BASE_URL}/workspaces/${config.honchoWorkspaceId}/peers/user/chat`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.honchoApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, reasoning_level: "low" }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Honcho dialectic chat failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { content?: string };
  return data.content ?? "";
}
