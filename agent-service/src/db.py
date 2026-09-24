"""Read-only reads against a schema-configurable view of the persona/skills
data - direct port of chat-orchestrator/src/db.ts. 'public' (the real views
onto n8n's live Data Tables) for production, 'chat_test' for the side-by-side
test instance. Nothing here ever writes: approving a skill or editing a
persona still happens exactly where it does today, in n8n's Data Table UI.
"""

from __future__ import annotations

from dataclasses import dataclass

import asyncpg

from .config import Config

_pool: asyncpg.Pool | None = None


async def _get_pool(config: Config) -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            host=config.postgres.host,
            port=config.postgres.port,
            database=config.postgres.n8n_database,
            user=config.postgres.user,
            password=config.postgres.password,
        )
    return _pool


def _qualify(schema: str, table: str) -> str:
    # Schema names are config-derived, never user input, but quoting still
    # guards against a stray special character in a misconfigured env var -
    # same reasoning as db.ts's qualify().
    return f'"{schema.replace(chr(34), chr(34) * 2)}"."{table}"'


async def get_persona_system_prompt(config: Config, name: str = "Amy") -> str | None:
    pool = await _get_pool(config)
    row = await pool.fetchrow(
        f"SELECT system_prompt FROM {_qualify(config.db_schema, 'personas')} WHERE name = $1 LIMIT 1",
        name,
    )
    return row["system_prompt"] if row else None


@dataclass(frozen=True)
class ActiveSkillRow:
    name: str
    description: str
    instructions: str


async def get_active_instruction_skills(config: Config) -> list[ActiveSkillRow]:
    pool = await _get_pool(config)
    rows = await pool.fetch(
        f"SELECT name, description, instructions FROM {_qualify(config.db_schema, 'skills')} "
        "WHERE status = 'active' AND kind = 'instruction'"
    )
    return [ActiveSkillRow(name=r["name"], description=r["description"], instructions=r["instructions"]) for r in rows]
