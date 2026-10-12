"""Skills library: real `SKILL.md` files on disk, following the Agent
Skills spec (https://agentskills.io/specification) - a `name`/`description`/
`metadata` YAML frontmatter block followed by a Markdown body, one directory
per skill. Postgres keeps operational state (status, approval tier,
timestamps, the active-skill index `db.get_active_instruction_skills`
already reads); this module owns the actual skill content - the same
"filesystem artifacts hold detailed content, Postgres holds the state
needed to operate reliably" split this project already committed to
elsewhere (docs/unified-architecture-gap-analysis.md §11).

Why files instead of another Postgres column: a skill is exactly the kind
of durable, human-readable artifact that principle describes - inspectable
directly in a text editor, diffable, and in the same format Claude Code's
own Skill tool already reads, rather than a bespoke one only this project
understands.
"""

from __future__ import annotations

import os
import re

import yaml

from .config import Config

_SLUG_INVALID = re.compile(r"[^a-z0-9]+")
_FRONTMATTER_DELIM = re.compile(r"(?m)^---\s*$")


def slugify(text: str, max_len: int = 64) -> str:
    """The spec's `name` constraints: lowercase alphanumeric and hyphens
    only, no leading/trailing/consecutive hyphens, max 64 chars."""
    slug = _SLUG_INVALID.sub("-", text.strip().lower()).strip("-")
    slug = re.sub(r"-+", "-", slug)
    slug = slug[:max_len].strip("-")
    return slug or "skill"


def _skill_dir(config: Config, name: str) -> str:
    return os.path.join(config.skills_library_path, name)


def write_skill(config: Config, name: str, description: str, body: str, metadata: dict[str, str]) -> str:
    """Writes `<skills_library_path>/<name>/SKILL.md`. `name` must already
    be a valid slug (growth_teaching.py calls slugify() once, up front, so
    the exact same name is also what the Postgres skills-index row and
    this file path both use - never re-derived differently in two places).
    `metadata` must be a flat string->string map per the spec."""
    frontmatter = yaml.safe_dump(
        {"name": name, "description": description, "metadata": metadata},
        sort_keys=False,
        default_flow_style=False,
        allow_unicode=True,
    )
    content = f"---\n{frontmatter}---\n\n{body.strip()}\n"
    skill_dir = _skill_dir(config, name)
    os.makedirs(skill_dir, exist_ok=True)
    path = os.path.join(skill_dir, "SKILL.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


def read_skill_body(config: Config, name: str) -> str | None:
    """Returns just the Markdown body (frontmatter stripped) - None if no
    file exists for this name, so callers (db.get_active_instruction_skills)
    can fall back to a legacy Postgres-only skill that predates this
    module and was never migrated to a file."""
    path = os.path.join(_skill_dir(config, name), "SKILL.md")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        content = f.read()
    parts = _FRONTMATTER_DELIM.split(content, maxsplit=2)
    if len(parts) < 3:
        return content.strip()
    return parts[2].strip()
