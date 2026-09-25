"""Env-driven config for scrapling-service."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _int_env(name: str, default: int) -> int:
    value = os.environ.get(name)
    return int(value) if value else default


@dataclass(frozen=True)
class Config:
    port: int
    # Non-2xx statuses on the plain Fetcher attempt that are worth retrying
    # with StealthyFetcher - real anti-bot/rate-limit signals, not generic
    # client errors (a 404 retrying with a browser would just waste ~658MB
    # worth of startup cost for the same "not found" result).
    stealth_retry_statuses: tuple[int, ...]


def load_config(env: dict[str, str] | None = None) -> Config:
    env = env if env is not None else dict(os.environ)
    return Config(
        port=_int_env("PORT", 3013),
        stealth_retry_statuses=(403, 429, 503),
    )
