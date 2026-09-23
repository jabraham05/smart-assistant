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
  "self-growth": ["skill_propose", "code_task", "code_task_status", "project_propose", "status_overview", "project_complete"],
  dashboard: ["dashboard_control"],
  web: ["web_search"],
  knowledge: ["knowledge_search", "knowledge_ingest"],
  research: ["research_task", "research_task_status", "status_overview", "project_complete"],
  goals: ["goal_manage", "project_propose", "status_overview", "project_complete"],
};

const CLASSIFIER_SYSTEM_PROMPT =
  "Classify which capability categories (zero, one, or a few) might be needed to respond to the user's " +
  "message. Categories: 'media' (music/Spotify playback control), 'scheduling' (calendar events), " +
  "'info' (weather, or recalling facts/preferences ABOUT THE USER THEMSELVES specifically - their " +
  "traits, likes, past statements - never a document, manual, or reference material), 'self-growth' " +
  "(proposing a new skill/tool, starting a coding task on a repo, checking on a coding task's " +
  "progress, or proposing a longer-term coding project for approval before work starts), 'dashboard' " +
  "(moving, resizing, showing, or hiding widgets on the smart-mirror dashboard), " +
  "'web' (searching the live web for current information, news, or facts that could have changed since " +
  "training, OR looking something up online in general such as finding products, links, or " +
  "recommendations - e.g. 'find me a good pair of headphones', 'give me some links for X'), " +
  "'knowledge' (looking up or searching within a specific document/manual/guide Amy has " +
  "stored, or anything else already saved in Amy's knowledge base/past research - e.g. 'do you have " +
  "the manual for my car', 'what does the guide say about X', 'look up Y in what we saved', 'what have " +
  "you already learned about X' where X is a topic and not the user themselves - or saving a specific " +
  "web page for later recall), 'research' (starting in-depth background research on a topic " +
  "not already known, that should be saved for later, OR checking on/asking about findings from " +
  "research that may have already happened - 'what have you found out about X', 'any updates on the " +
  "research', 'how's that going' - include 'research' for these EVEN IF X also matches an existing " +
  "goal or project; the two aren't mutually exclusive, and research about a goal's topic is common), " +
  "'goals' " +
  "(creating, listing, updating, or checking progress on the user's persistent personal objectives - " +
  "life goals like job search/fitness/savings, but just as much a new hobby/technical/creative project " +
  "the user mentions wanting to start or work on, e.g. 'I have a new project idea, I want to build a " +
  "robotics arm', 'I'm going to learn guitar' - these classify 'goals' too, not just the traditional " +
  "life-objective examples). A question about a specific named document, manual, or guide is " +
  "always 'knowledge', never 'info' - 'info' is only for facts about the user as a person, not things " +
  "Amy has stored. Most messages need none at all - only include a category if it's genuinely likely " +
  "needed.\n\n" +
  "Also classify four independent policy fields:\n" +
  "- toolPolicy: 'required' if answering correctly depends on live/authoritative data or performing a " +
  "real action (e.g. anything calendar, weather, goals, Spotify, dashboard, research, or coding-task " +
  "related) - the assistant must not guess or answer from memory here. 'optional' for general " +
  "conversation, opinions, or facts that don't depend on the user's actual live state.\n" +
  "- memoryPolicy: 'none' for a message with no personal relevance at all (a trivia question, small " +
  "talk with no follow-up value). 'required' when the user explicitly asks about their own past " +
  "statements, preferences, or history ('what did I tell you about X', 'what do you remember about " +
  "me'). 'relevant' when personal context would materially improve the answer even though it wasn't " +
  "explicitly asked for. 'optional' otherwise (the default for most ordinary conversation).\n" +
  "- needsPlanning: true only for a genuinely multi-step request that should be broken into tracked " +
  "steps rather than answered in one shot (e.g. 'plan my trip', 'help me reorganize my week around my " +
  "calendar'). False for anything answerable or doable in this one turn.\n" +
  "- background: true only when the user explicitly wants something done later/in the background " +
  "without waiting for it now (e.g. 'look into X overnight and let me know', 'do some deep research on " +
  "this and get back to me'). False otherwise, including for normal 'research' requests where the user " +
  "is waiting on the reply.\n" +
  "- knowledgeGapTopic: a short topic string (a few words) ONLY when the user expresses genuine ongoing " +
  "interest in a specific topic/project they want to learn about or work on - something Amy likely " +
  "knows little about and should go quietly research in the background, not something to answer right " +
  "now. Example: 'I have a new project idea, I want to build a robotics arm' -> \"robotics arm design " +
  "and construction\". null for everything else, including: a direct question expecting an immediate " +
  "answer (that's 'web'/'knowledge' - answered now, not queued for later), small talk, or anything " +
  "already covered earlier in this same conversation. When genuinely unsure, use null - this is for " +
  "clear, specific new interests, not a guess on every message.\n" +
  "- behaviorFeedbackCategory/behaviorFeedbackNote: capture ONLY when the user is giving feedback about " +
  "a REPEATED pattern in Amy's own behavior or approach across conversations - e.g. 'you keep giving me " +
  "too much detail', 'you have trouble remembering our past conversations', 'you always use the wrong " +
  "tool for this'. This is NOT the same as correcting a single mistake in the current turn (e.g. 'no, I " +
  "meant tomorrow', 'that's not what I asked for') - those are ordinary corrections, not behavior " +
  "feedback; use null for them. category is one of: 'communication' (tone, verbosity, clarity), " +
  "'tool_selection' (using the wrong tool or unnecessary tool use), 'memory_retrieval' (failing to " +
  "recall past context), 'planning' (over/under-complicating multi-step work), 'proactivity' (not " +
  "noticing or acting on something it should have), 'other' for anything not covered by these. note is " +
  "a short paraphrase of what the user actually said. Both null when no such feedback is present - most " +
  "messages have none. Base this ONLY on the CURRENT message below, never on the prior exchange shown " +
  "for context - if the current message doesn't itself contain feedback, use null even if the prior " +
  "exchange did.\n\n" +
  "You may also be given the single most recent exchange as brief prior context, labeled 'Prior " +
  "exchange (for reference only)'. Use it ONLY to resolve what a vague follow-up refers to (\"fix " +
  "that\", \"change it to 11am today\", \"actually make it Tuesday\", \"delete it\") - classify based " +
  "on what the user is actually asking for once resolved, not the prior exchange's own content. A " +
  "correction to something just scheduled is still 'scheduling'; a correction to a task just created " +
  "is still whatever category the task itself was.";

const CLASSIFIER_FORMAT = {
  type: "object",
  properties: {
    relevantGroups: {
      type: "array",
      items: { type: "string", enum: TOOL_GROUPS },
    },
    toolPolicy: { type: "string", enum: ["required", "optional"] },
    memoryPolicy: { type: "string", enum: ["none", "optional", "relevant", "required"] },
    needsPlanning: { type: "boolean" },
    background: { type: "boolean" },
    knowledgeGapTopic: { type: ["string", "null"] },
    behaviorFeedbackCategory: {
      type: ["string", "null"],
      enum: ["communication", "tool_selection", "memory_retrieval", "planning", "proactivity", "other", null],
    },
    behaviorFeedbackNote: { type: ["string", "null"] },
  },
  required: [
    "relevantGroups",
    "toolPolicy",
    "memoryPolicy",
    "needsPlanning",
    "background",
    "knowledgeGapTopic",
    "behaviorFeedbackCategory",
    "behaviorFeedbackNote",
  ],
};

export type ToolPolicy = "required" | "optional";
export type MemoryPolicy = "none" | "optional" | "relevant" | "required";

export interface ClassificationResult {
  relevantGroups: string[];
  relevantTools: string[];
  toolPolicy: ToolPolicy;
  memoryPolicy: MemoryPolicy;
  needsPlanning: boolean;
  background: boolean;
  // Self-learning research queue (see docs/chat-orchestrator.md's
  // Coordinator section and docs/memory-engine.md's sibling,
  // knowledge-engine's research-queue.ts) - a short topic string when this
  // message reveals a knowledge gap worth researching in the background,
  // null otherwise. Never gates tool binding the way the other fields do;
  // consumed by index.ts as a fire-and-forget enqueue after classification.
  knowledgeGapTopic: string | null;
  // Feedback-capture: set when the user described a REPEATED pattern in
  // Amy's own behavior, not a one-off correction (see the prompt's own
  // distinction). Never gates tool binding; consumed by index.ts as a
  // fire-and-forget event-bus log after classification - the first
  // building block of the self-improvement loop discussed alongside the
  // /amy projects feature (see docs/chat-orchestrator.md's dated entry).
  behaviorFeedback: { category: string; note: string } | null;
}

const TOOL_POLICIES: readonly ToolPolicy[] = ["required", "optional"];
const MEMORY_POLICIES: readonly MemoryPolicy[] = ["none", "optional", "relevant", "required"];
const BEHAVIOR_FEEDBACK_CATEGORIES = [
  "communication",
  "tool_selection",
  "memory_retrieval",
  "planning",
  "proactivity",
  "other",
];

export async function classifyRelevantTools(
  ollamaHost: string,
  model: string,
  chatInput: string,
  // Last exchange only (not full history) - just enough to resolve an
  // anaphoric follow-up ("fix that", "delete it"), kept short since this
  // call is latency-sensitive and runs on every single message. See
  // classify-tools.ts's header comment on the real bug this fixes: a
  // context-free classifier can't tell a correction to a just-created
  // calendar event apart from an unrelated 'info' message, so the
  // required tool never even gets bound for the model to call.
  recentContext?: string,
): Promise<ClassificationResult> {
  try {
    const { message } = await ollamaChat(ollamaHost, {
      model,
      think: false,
      timeoutMs: 30_000,
      format: CLASSIFIER_FORMAT,
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        ...(recentContext
          ? [{ role: "user" as const, content: `Prior exchange (for reference only):\n${recentContext}` }]
          : []),
        { role: "user", content: chatInput },
      ],
    });
    const parsed = parseJsonContent<{
      relevantGroups?: string[];
      toolPolicy?: string;
      memoryPolicy?: string;
      needsPlanning?: boolean;
      background?: boolean;
      knowledgeGapTopic?: string | null;
      behaviorFeedbackCategory?: string | null;
      behaviorFeedbackNote?: string | null;
    }>(message.content, {});
    const relevantGroups = (parsed.relevantGroups ?? []).filter((g): g is ToolGroup =>
      (TOOL_GROUPS as readonly string[]).includes(g),
    );
    const toolPolicy: ToolPolicy = TOOL_POLICIES.includes(parsed.toolPolicy as ToolPolicy)
      ? (parsed.toolPolicy as ToolPolicy)
      : "optional";
    const memoryPolicy: MemoryPolicy = MEMORY_POLICIES.includes(parsed.memoryPolicy as MemoryPolicy)
      ? (parsed.memoryPolicy as MemoryPolicy)
      : "optional";
    const needsPlanning = parsed.needsPlanning === true;
    const { background, relevantTools: toolsAfterBackground } = applyBackgroundOverride(
      parsed.background === true,
      relevantGroups,
      expandGroupsToTools(relevantGroups),
    );
    // Force-expose memory_recall for relevant/required memoryPolicy even
    // if 'info' wasn't classified - same reasoning as background's
    // research_task force-include above: the field this policy describes
    // needs the tool actually bound to be actionable, not just logged.
    const relevantTools =
      memoryPolicy === "relevant" || memoryPolicy === "required"
        ? [...new Set([...toolsAfterBackground, "memory_recall"])]
        : toolsAfterBackground;

    const knowledgeGapTopic =
      typeof parsed.knowledgeGapTopic === "string" && parsed.knowledgeGapTopic.trim()
        ? parsed.knowledgeGapTopic.trim()
        : null;

    const behaviorFeedback =
      typeof parsed.behaviorFeedbackCategory === "string" &&
      BEHAVIOR_FEEDBACK_CATEGORIES.includes(parsed.behaviorFeedbackCategory) &&
      typeof parsed.behaviorFeedbackNote === "string" &&
      parsed.behaviorFeedbackNote.trim()
        ? { category: parsed.behaviorFeedbackCategory, note: parsed.behaviorFeedbackNote.trim() }
        : null;

    return {
      relevantGroups,
      relevantTools,
      toolPolicy,
      memoryPolicy,
      needsPlanning,
      background,
      knowledgeGapTopic,
      behaviorFeedback,
    };
  } catch (e) {
    // Classifier failure degrades to "only calculate" rather than "all
    // tools" - a classifier hiccup can't reintroduce the exact
    // large-tool-set failure mode this step exists to avoid. Policy
    // fields degrade to their safest defaults: optional/optional/false/false.
    console.error("classifyRelevantTools failed, falling back to calculate-only:", e);
    return {
      relevantGroups: [],
      relevantTools: expandGroupsToTools([]),
      toolPolicy: "optional",
      memoryPolicy: "optional",
      needsPlanning: false,
      background: false,
      knowledgeGapTopic: null,
      behaviorFeedback: null,
    };
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

// Force-expose research_task/research_task_status for a background
// request even if 'research' wasn't classified - the model still needs
// the tool bound to actually act on the user's "do this later" intent.
// A background request that's actually about something else entirely
// (Spotify, the calendar) has nothing to hand off to yet - there is no
// generic background-any-tool executor - so it silently falls back to
// the normal synchronous path rather than claiming a background mode
// that can't do anything differently.
export function applyBackgroundOverride(
  background: boolean,
  relevantGroups: string[],
  relevantTools: string[],
): { background: boolean; relevantTools: string[] } {
  if (!background) return { background: false, relevantTools };
  const hasBackgroundableWork = relevantGroups.includes("research") || relevantGroups.includes("web");
  if (!hasBackgroundableWork) return { background: false, relevantTools };
  return { background: true, relevantTools: [...new Set([...relevantTools, "research_task", "research_task_status"])] };
}
