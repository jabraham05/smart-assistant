"""Growth engine Phase 7: Skills v2 runtime (discovery + leveled loading).
Additive to the existing authoring pipeline (skill_propose/skill_gap_scanner/
human approval/the live `skills` table, all unchanged) - this only changes
WHICH of the already-approved, active skills get loaded into a given
turn's prompt, and how much of each.

A skill with no skill_metadata row (postgres/init/26-create-skill-metadata-
table.sql) behaves exactly as it does today: always injected, full
instructions. This is a filter/compressor layered on top of the existing
catalog, never a requirement to register metadata before a skill works -
"a much smaller change than rebuilding skills entirely," per the roadmap.
"""

from __future__ import annotations

import logging

import asyncpg

from .config import Config
from .db import ActiveSkillRow

logger = logging.getLogger(__name__)

_pool: asyncpg.Pool | None = None


async def _get_pool(config: Config) -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            host=config.postgres.host,
            port=config.postgres.port,
            database=config.postgres.skills_database,
            user=config.postgres.user,
            password=config.postgres.password,
        )
    return _pool


async def get_skill_metadata(config: Config) -> dict[str, dict]:
    """Fetched once per turn alongside active_skills - a small table, no
    caching needed yet. Never raises: a lookup failure just means every
    skill falls back to always-on/full-instructions, the safe default."""
    try:
        pool = await _get_pool(config)
        rows = await pool.fetch("SELECT * FROM skill_metadata")
        return {r["skill_name"]: dict(r) for r in rows}
    except Exception:
        logger.exception("skills_discovery.get_skill_metadata failed")
        return {}


def _is_relevant(skill_name: str, meta: dict | None, chat_input: str, relevant_groups: list[str]) -> bool:
    if not meta or not meta.get("triggers"):
        return True
    lowered = chat_input.lower()
    triggers = meta.get("triggers") or []
    return any(t.lower() in lowered for t in triggers) or skill_name.lower() in (g.lower() for g in relevant_groups)


def discover_relevant_skills(
    active_skills: list[ActiveSkillRow],
    metadata: dict[str, dict],
    chat_input: str,
    relevant_groups: list[str],
) -> list[ActiveSkillRow]:
    """Deterministic keyword-trigger filter - same rule-based-over-LLM-call
    preference as the rest of this project's routing logic (classify.py's
    GROUPS, knowledge-engine's router.ts), rather than an extra model call
    per skill on every turn. Phase 7.2 dependency composition: a skill
    pulled in by a trigger match also pulls in its declared dependencies
    even if they didn't match themselves, capped at one level deep so an
    accidental dependency cycle can't silently pull in the whole catalog."""
    selected = [s for s in active_skills if _is_relevant(s.name, metadata.get(s.name), chat_input, relevant_groups)]
    selected_names = {s.name for s in selected}
    for skill in list(selected):
        deps = (metadata.get(skill.name) or {}).get("dependencies") or []
        for dep_name in deps:
            if dep_name in selected_names:
                continue
            dep_skill = next((s for s in active_skills if s.name == dep_name), None)
            if dep_skill:
                selected.append(dep_skill)
                selected_names.add(dep_name)
    return selected


def render_skills_catalog_text(active_skills: list[ActiveSkillRow], metadata: dict[str, dict]) -> str:
    """L1 (name/description) + L2 (summary, falling back to the full
    instructions when a skill has no metadata yet) for every selected
    skill. L3/L4 (detailed procedure/examples) are registered but not yet
    surfaced here - there's no "drill into this skill" mechanism in a
    single-pass prompt assembly to make use of them yet; see
    docs/growth-engine.md for that as explicit follow-up scope, not a
    silent gap."""
    parts = []
    for skill in active_skills:
        meta = metadata.get(skill.name)
        body = (meta.get("level2_summary") if meta else None) or skill.instructions
        parts.append(f"## {skill.name}\n{skill.description}\n\n{body}")
    return "\n\n".join(parts)
