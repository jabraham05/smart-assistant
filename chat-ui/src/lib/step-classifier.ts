import type { StepKind } from "@/types/chat";

// Maps a skills-mcp tool name (as invoked by chat-orchestrator's agent loop -
// see ChatTraceEvent's "tool_call" kind) to a friendly step kind + label.
// Falls back to a generic label for any tool not listed here, so a newly
// registered skills-mcp tool still shows up instead of being dropped.
const TOOL_LABELS: Record<string, { kind: StepKind; label: string }> = {
  calculate: { kind: "tool_call", label: "Calculating" },
  weather_get: { kind: "tool_call", label: "Checking the weather" },
  memory_recall: { kind: "tool_call", label: "Recalling a memory" },
  spotify_control: { kind: "tool_call", label: "Controlling Spotify" },
  calendar_event: { kind: "tool_call", label: "Managing your calendar" },
  skill_propose: { kind: "tool_call", label: "Proposing a new skill" },
  code_task: { kind: "tool_call", label: "Starting a coding task" },
  code_task_status: { kind: "tool_call", label: "Checking coding task status" },
  dashboard_control: { kind: "tool_call", label: "Adjusting the dashboard" },
  web_search: { kind: "tool_call", label: "Searching the web" },
  knowledge_search: { kind: "tool_call", label: "Searching my knowledge base" },
  knowledge_ingest: { kind: "data_saved", label: "Saving to my knowledge base" },
  research_task: { kind: "tool_call", label: "Starting research" },
  research_task_status: { kind: "tool_call", label: "Checking research progress" },
  goal_manage: { kind: "tool_call", label: "Updating your goals" },
  project_propose: { kind: "tool_call", label: "Proposing a project" },
  status_overview: { kind: "tool_call", label: "Checking on everything in progress" },
  project_complete: { kind: "tool_call", label: "Wrapping up a project" },
};

export function classifyTool(name: string): { kind: StepKind; label: string } {
  return TOOL_LABELS[name] ?? { kind: "other", label: `Calling ${name}` };
}
