import type { ChatTraceEvent, ProjectProposalCard } from "@/types/chat";

const MARKER_RE = /\[\[PROJECT_CARD\]\]([\s\S]*?)\[\[\/PROJECT_CARD\]\]/;

// Parses the [[PROJECT_CARD]]...[[/PROJECT_CARD]] marker skills-mcp's
// project-propose.ts embeds at the end of a project_propose tool result -
// see that file for the producer side. Returns undefined on any parse
// failure or shape mismatch so a malformed/truncated marker never breaks
// chat rendering, it just silently falls back to plain text.
export function parseProjectCard(event: ChatTraceEvent): ProjectProposalCard | undefined {
  if (event.kind !== "tool_result" || event.name !== "project_propose" || event.isError) return undefined;

  const match = event.result.match(MARKER_RE);
  if (!match) return undefined;

  try {
    const parsed = JSON.parse(match[1]) as Partial<ProjectProposalCard>;
    if (
      typeof parsed.id !== "number" ||
      typeof parsed.title !== "string" ||
      typeof parsed.rationale !== "string" ||
      typeof parsed.status !== "string"
    ) {
      return undefined;
    }
    return { id: parsed.id, title: parsed.title, rationale: parsed.rationale, status: parsed.status, duplicate: !!parsed.duplicate };
  } catch {
    return undefined;
  }
}
