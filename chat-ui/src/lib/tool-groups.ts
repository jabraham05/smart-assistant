// Display-only duplicate of chat-orchestrator's GROUPS map
// (chat-orchestrator/src/classify-tools.ts) - same "separate build, no
// shared package today" convention already used for other small lookup
// tables in this project (see step-classifier.ts). A newly registered tool
// not yet added here just falls back to "Other" below rather than breaking
// anything - this only affects how the Agent Registry panel groups tools
// for display, never which tools actually get bound to a turn.
export const TOOL_GROUP_LABEL: Record<string, string> = {
  media: "Media",
  scheduling: "Scheduling",
  info: "Info",
  "self-growth": "Self-growth",
  dashboard: "Dashboard",
  web: "Web",
  knowledge: "Knowledge",
  research: "Research",
  goals: "Goals",
};

const GROUP_FOR_TOOL: Record<string, string> = {
  spotify_control: "media",
  calendar_event: "scheduling",
  weather_get: "info",
  memory_recall: "info",
  skill_propose: "self-growth",
  code_task: "self-growth",
  code_task_status: "self-growth",
  run_command: "self-growth",
  get_diff: "self-growth",
  write_file: "self-growth",
  dashboard_control: "dashboard",
  web_search: "web",
  knowledge_search: "knowledge",
  knowledge_ingest: "knowledge",
  research_task: "research",
  research_task_status: "research",
  goal_manage: "goals",
  project_propose: "goals",
};

const OTHER_GROUP = "other";

export function groupForTool(name: string): string {
  return GROUP_FOR_TOOL[name] ?? OTHER_GROUP;
}

export function groupLabel(group: string): string {
  return TOOL_GROUP_LABEL[group] ?? "Always available";
}
