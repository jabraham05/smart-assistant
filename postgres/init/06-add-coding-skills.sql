-- Only runs against a fresh, empty postgres-data volume (docker-entrypoint-initdb.d
-- behavior). If this volume already existed before this file was added (true for
-- this project as of 2026-08), apply it manually instead:
--   docker compose exec -i postgres psql -U assistant -d coding_tasks < postgres/init/06-add-coding-skills.sql
\connect coding_tasks

-- Owned by coding-orchestrator. Lessons learned from real task failures,
-- injected into the Coder/Tester system prompts at runtime instead of
-- being hand-edited into hardcoded prompt string constants every time a
-- new mistake is found - editable without a redeploy. See
-- db.ts's getActiveCodingSkills / pipeline.ts's runCoderRound/
-- runTesterRound.
CREATE TABLE coding_skills (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'both',   -- 'coder' | 'tester' | 'both'
  template    TEXT,                            -- NULL = applies regardless of the task's chosen template
  content     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'proposed' | 'rejected'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX coding_skills_status_idx ON coding_skills (status);

-- Seeded as trusted/active directly (not routed through a review step) -
-- these already lived as hand-written prompt text and were proven
-- correct in production before being migrated here.
INSERT INTO coding_skills (name, role, template, content) VALUES
(
  'config-files-valid-syntax',
  'both',
  NULL,
  'Config files like package.json, jest.config.js, pytest.ini, babel.config.js, etc. must be valid code in their host language - for a .js file that means module.exports = {...}, never raw JSON syntax. Writing JSON directly into a .js file causes an immediate SyntaxError.'
),
(
  'prefer-commonjs',
  'both',
  NULL,
  'For a JavaScript/Node task, use CommonJS (require/module.exports), not ES module import/export syntax, unless the task explicitly needs ESM or the project already has "type": "module" in its package.json - Jest''s zero-config default can only parse CommonJS, and getting ESM working there needs extra Babel setup that''s easy to get wrong and waste time on.'
),
(
  'respect-existing-scaffold',
  'both',
  NULL,
  'If config files like package.json, jest.config.js, pytest.ini, etc. already exist in the working directory, they''re a known-working starting scaffold - build on them, don''t rewrite them, unless the task specifically calls for different tooling.'
),
(
  'clean-up-template-placeholders',
  'both',
  NULL,
  'If the working directory already contains placeholder/example files from a starter template (e.g. src/index.js with a trivial add(a,b) demo and its matching test), delete or fully replace them once you''ve implemented the real feature - leaving them alongside real code confuses the Reviewer about what was actually implemented and can make a genuinely passing test suite look incomplete.'
);
