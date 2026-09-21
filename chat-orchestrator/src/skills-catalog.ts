import type { ActiveSkillRow } from "./db.js";

// Ported verbatim from the n8n Chat workflow's "Format Skills Catalog"
// Code node: rows without a name are dropped, everything else joined as
// one markdown block, empty string if there's nothing active.
export function formatSkillsCatalog(skills: ActiveSkillRow[]): string {
  const named = skills.filter((s) => s.name);
  if (named.length === 0) return "";
  return named.map((s) => `## ${s.name}\n${s.description}\n\n${s.instructions}`).join("\n\n");
}
