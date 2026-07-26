import type { ChatRequest } from "@/types/chat";

// Server-side only: the n8n webhook URL never reaches the browser.
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

// Returns the raw streaming response from n8n's Chat Trigger (responseMode:
// "streaming") so the caller can pipe it straight through to the browser
// instead of waiting for the full reply.
export async function streamFromN8n(request: ChatRequest): Promise<Response> {
  if (!N8N_WEBHOOK_URL) {
    throw new Error("N8N_WEBHOOK_URL is not configured");
  }

  const res = await fetch(N8N_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // n8n's Chat Trigger expects `chatInput`/`sessionId`, not our own ChatRequest shape.
    body: JSON.stringify({ chatInput: request.message, sessionId: request.sessionId }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`n8n webhook responded with ${res.status}`);
  }

  return res;
}
