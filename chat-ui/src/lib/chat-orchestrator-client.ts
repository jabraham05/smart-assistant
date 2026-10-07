// Server-side only, same "no client-side secrets/URLs" shape as
// knowledge-engine-client.ts/coding-orchestrator-client.ts - chat-orchestrator
// is internal-only (no published port on assistant-net besides the host-only
// 3008 publish used for scripts/chat.mjs), so this only ever runs from a
// Next.js API route. Used only for the two read-only profile endpoints below
// (persona, Honcho peer cards) - live chat traffic goes to agent-service, not
// chat-orchestrator (see docker-compose.yml's chat-ui N8N_WEBHOOK_URL), but
// chat-orchestrator still owns the real db.getPersonaSystemPrompt/
// honcho.getUserCard lookups, so these two routes are read straight from it
// rather than re-implemented here.
const CHAT_ORCHESTRATOR_URL = process.env.CHAT_ORCHESTRATOR_URL ?? "http://chat-orchestrator:3006";

export async function getPersona(): Promise<string | null> {
  const res = await fetch(`${CHAT_ORCHESTRATOR_URL}/persona`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`chat-orchestrator /persona failed with ${res.status}`);
  }
  const data = (await res.json()) as { systemPrompt: string | null };
  return data.systemPrompt;
}

export interface UserProfile {
  userCard: string[];
  userCardForAmy: string[];
}

export async function getUserProfile(): Promise<UserProfile> {
  const res = await fetch(`${CHAT_ORCHESTRATOR_URL}/user-profile`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`chat-orchestrator /user-profile failed with ${res.status}`);
  }
  return (await res.json()) as UserProfile;
}
