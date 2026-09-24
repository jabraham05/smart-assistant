import { fetchTimeoutSignal } from "./fetch-timeout";

// Server-side only, same "no client-side secrets/URLs" shape as every
// other internal-service client here. chat-orchestrator has no published
// port either - this is the first chat-ui caller of it besides the
// existing chat webhook (N8N_WEBHOOK_URL, a different base path).
const CHAT_ORCHESTRATOR_URL = process.env.CHAT_ORCHESTRATOR_URL ?? "http://chat-orchestrator:3006";

export interface PersonaSnapshot {
  personaSystemPrompt: string;
  activeSkills: { name: string; description: string; instructions: string }[];
}

// Powers Amy Lab's Persona tab - the real, live persona text and active
// instruction skills, not a hardcoded description of prompt structure.
// Read-only, matches the standing convention that persona editing only
// happens in n8n's Data Table UI.
export async function getPersonaSnapshot(): Promise<PersonaSnapshot> {
  const res = await fetch(`${CHAT_ORCHESTRATOR_URL}/persona-snapshot`, {
    cache: "no-store",
    signal: fetchTimeoutSignal(),
  });
  if (!res.ok) {
    throw new Error(`chat-orchestrator /persona-snapshot failed with ${res.status}`);
  }
  return res.json();
}
