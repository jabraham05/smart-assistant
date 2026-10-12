-- Growth engine Teaching layer follow-up: skills are now written as real
-- SKILL.md files (https://agentskills.io/specification), which requires a
-- proper kebab-case `name` and a real discovery `description` - not the
-- truncated raw captured text growth_consolidate.py previously dumped into
-- both fields. The judge now produces these alongside the existing
-- procedure/rules/examples extraction when category='skill'.
ALTER TABLE teaching_sessions
  ADD COLUMN IF NOT EXISTS skill_name TEXT,
  ADD COLUMN IF NOT EXISTS discovery_description TEXT;
