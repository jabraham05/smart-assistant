import { ollamaChat, parseJsonContent } from "./ollama.js";

// Ported verbatim from the n8n Chat workflow's "Classify Relevant Tool
// Groups" + "Expand Groups To Tools" nodes. This step already bypassed the
// AI Agent/LangChain entirely (a plain raw-Ollama call with structured
// output) - it isn't part of what's broken, and it's mitigating a real,
// measured, client-independent qwen3:8b limitation (tool-selection
// reliability degrades as bound tool count grows - see
// docs/chat-workflow.md's ollama-mcp-bridge test), not just an n8n
// workaround. It gets ported near-unchanged rather than reconsidered.

export const TOOL_GROUPS = [
  "media",
  "scheduling",
  "info",
  "self-growth",
  "dashboard",
  "web",
  "knowledge",
  "research",
  "goals",
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

// Single source of truth for which tools each category exposes - same
// maintenance-cost tradeoff the original n8n Code node had: this lives
// separately from skills-mcp's own tool registration, so a newly added
// tool is silently never exposed to chat unless it's also added here.
export const GROUPS: Record<ToolGroup, string[]> = {
  media: ["spotify_control"],
  scheduling: ["calendar_event"],
  info: ["weather_get", "memory_recall"],
  "self-growth": ["skill_propose", "code_task", "code_task_status"],
  dashboard: ["dashboard_control"],
  web: ["web_search"],
  knowledge: ["knowledge_search", "knowledge_ingest"],
  research: ["research_task", "research_task_status"],
  goals: ["goal_manage"],
};

const CLASSIFIER_SYSTEM_PROMPT =
  "Classify which capability categories (zero, one, or a few) might be needed to respond to the user's " +
  "message. Categories: 'media' (music/Spotify playback control), 'scheduling' (calendar events), " +
  "'info' (weather, or recalling facts/preferences about the user), 'self-growth' (proposing a new " +
  "skill/tool, starting a coding task on a repo, or checking on a coding task's progress), 'dashboard' " +
  "(moving, resizing, showing, or hiding widgets on the smart-mirror dashboard), 'web' (searching the " +
  "live web for current information, news, or facts that could have changed since training), " +
  "'knowledge' (searching Amy's existing knowledge base/past research for something already known, or " +
  "saving a specific web page for later recall), 'research' (starting in-depth background research on " +
  "a topic not already known, that should be saved for later, or checking a research task's progress), " +
  "'goals' (creating, listing, updating, or checking progress on the user's persistent personal " +
  "objectives, e.g. job search, fitness, savings). Most messages need none at all - only include a " +
  "category if it's genuinely likely needed.";

const CLASSIFIER_FORMAT = {
  type: "object",
  properties: {
    relevantGroups: {
      type: "array",
      items: { type: "string", enum: TOOL_GROUPS },
    },
  },
  required: ["relevantGroups"],
};

export interface ClassificationResult {
  relevantGroups: string[];
  relevantTools: string[];
}

export async function classifyRelevantTools(
  ollamaHost: string,
  model: string,
  chatInput: string,
): Promise<ClassificationResult> {
  try {
    const { message } = await ollamaChat(ollamaHost, {
      model,
      think: false,
      timeoutMs: 30_000,
      format: CLASSIFIER_FORMAT,
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: chatInput },
      ],
    });
    const parsed = parseJsonContent<{ relevantGroups?: string[] }>(message.content, {});
    const relevantGroups = (parsed.relevantGroups ?? []).filter((g): g is ToolGroup =>
      (TOOL_GROUPS as readonly string[]).includes(g),
    );
    return { relevantGroups, relevantTools: expandGroupsToTools(relevantGroups) };
  } catch (e) {
    // Classifier failure degrades to "only calculate" rather than "all
    // tools" - a classifier hiccup can't reintroduce the exact
    // large-tool-set failure mode this step exists to avoid.
    console.error("classifyRelevantTools failed, falling back to calculate-only:", e);
    return { relevantGroups: [], relevantTools: expandGroupsToTools([]) };
  }
}

// "calculate" and "task_context_manage" are always exposed regardless of
// classification: calculate because a classifier miss can't be allowed to
// silently drop arithmetic/date-resolution (see docs/chat-workflow.md),
// and task_context_manage because an open cross-session task can be
// resumed by a message that doesn't obviously name any capability at all
// (matches the old n8n workflow's "Expand Groups To Tools" node - this
// port had dropped task_context_manage from the always-on set, a real
// regression fixed here).
export function expandGroupsToTools(relevantGroups: string[]): string[] {
  const tools = new Set<string>(["calculate", "task_context_manage"]);
  for (const g of relevantGroups) {
    const members = GROUPS[g as ToolGroup];
    if (members) for (const m of members) tools.add(m);
  }
  return [...tools];
}
