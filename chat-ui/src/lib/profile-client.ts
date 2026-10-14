// Server-side only, same "no client-side secrets/URLs" shape as
// growth-client.ts/knowledge-engine-client.ts - agent-service is internal-
// only (no published port on the host), so this only ever runs from a
// Next.js API route. Reuses the exact db.get_persona_system_prompt/
// honcho_client.get_user_card lookups agent-service's own system-prompt
// assembly already relies on (profile_routes.py - ported from
// chat-orchestrator, now retired, see docs/chat-orchestrator.md), rather
// than re-implemented here.
const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? "http://agent-service:3010";

export async function getPersona(): Promise<string | null> {
  const res = await fetch(`${AGENT_SERVICE_URL}/persona`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`agent-service /persona failed with ${res.status}`);
  }
  const data = (await res.json()) as { systemPrompt: string | null };
  return data.systemPrompt;
}

export interface UserProfile {
  userCard: string[];
  userCardForAmy: string[];
}

export async function getUserProfile(): Promise<UserProfile> {
  const res = await fetch(`${AGENT_SERVICE_URL}/user-profile`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`agent-service /user-profile failed with ${res.status}`);
  }
  return (await res.json()) as UserProfile;
}
