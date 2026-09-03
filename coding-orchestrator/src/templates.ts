// Names must exactly match the folder names under `_templates/` in the
// landing repo (CODING_TASKS_REPO_URL) - see that repo's own README/
// this project's README for what each one actually provides.
export const TEMPLATE_NAMES = ["node-jest", "python-pytest", "nextjs-app", "express-api"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

// Same defensive-normalization pattern used everywhere else an LLM's
// structured output feeds into real logic (e.g. skill_gap_scanner's
// kebab-case/dedup normalization) - the Planner's `format` schema already
// constrains this to a fixed enum, but never trust that alone, since a
// hallucinated/missing value here would otherwise silently become a
// literal (wrong) folder name in a shell command.
export function validateTemplate(raw: unknown): TemplateName | "none" {
  return typeof raw === "string" && (TEMPLATE_NAMES as readonly string[]).includes(raw) ? (raw as TemplateName) : "none";
}
