import type { RegisteredTool } from "@/types/chat";

// Server-side only, same "no client-side secrets/URLs" shape as
// event-bus-client.ts - skills-mcp is internal-only (no published port), so
// this only ever runs from a Next.js API route, never the browser.
const SKILLS_MCP_URL = process.env.SKILLS_MCP_URL ?? "http://skills-mcp:3001";

export async function listRegisteredTools(): Promise<RegisteredTool[]> {
  const res = await fetch(`${SKILLS_MCP_URL}/tools`);
  if (!res.ok) {
    throw new Error(`skills-mcp /tools failed with ${res.status}`);
  }
  const data = (await res.json()) as { tools: RegisteredTool[] };
  return data.tools;
}
