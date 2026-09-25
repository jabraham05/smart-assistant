"""Page fetching - Fetcher (no browser, cheap) first, falling back to
StealthyFetcher (a real browser, live-verified this session as a genuine
~658MB footprint) only when the plain fetch fails or is blocked. Not
bundled/used unconditionally - see config.py's stealth_retry_statuses and
this project's own docker-compose.yml comment on why, given this
machine's already-documented resource contention. Noted for a future
revisit: if the plain Fetcher path proves insufficient often enough in
practice, this can change to use StealthyFetcher by default instead of as
a fallback - a deliberate choice, not a limitation forgotten about.

Real, live-verified finding: this module returns raw HTML, not Scrapling's
own .markdown() output. `main_content_only=True` on that method doesn't do
Readability-style boilerplate stripping - it only means "convert what's
inside <body>, not <head>." Tested against a real Wikipedia article, it
returned the nav sidebar, not the article. Scrapling's genuine value here
is reliable fetching (JS rendering, anti-bot evasion), not content
extraction - so this module hands back raw HTML and lets
knowledge-engine's own already-proven JSDOM+Readability pipeline (see
lib/html-extract.ts) do the actual article extraction, same as it already
does for the plain-fetch fallback path, just fed better-fetched HTML.
"""

from __future__ import annotations

import logging

from scrapling import Fetcher, StealthyFetcher

from .config import Config

logger = logging.getLogger(__name__)


class ExtractError(Exception):
    pass


def fetch_html(config: Config, url: str) -> tuple[str, bool]:
    """Returns (html, used_stealth)."""
    try:
        response = Fetcher.get(url)
        if response.status not in config.stealth_retry_statuses:
            return _to_html(response), False
        logger.info("plain fetch got status %d for %s, retrying with StealthyFetcher", response.status, url)
    except Exception:
        logger.exception("plain fetch failed for %s, retrying with StealthyFetcher", url)

    try:
        response = StealthyFetcher.fetch(url)
    except Exception as e:
        raise ExtractError(f"both plain and stealth fetch failed for {url}: {e}") from e
    if response.status >= 400:
        raise ExtractError(f"stealth fetch got status {response.status} for {url}")
    return _to_html(response), True


def _to_html(response) -> str:
    html = str(response.html_content)
    if not html.strip():
        raise ExtractError("fetch produced no content")
    return html
