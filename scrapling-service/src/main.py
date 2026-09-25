"""FastAPI wrapper around Scrapling - Phase 4's real page fetching,
replacing knowledge-engine's plain fetch() (no JS rendering, no anti-bot
evasion) as the fetch step in its existing extractUrl pipeline. Returns
raw HTML, not pre-extracted content - see extract.py for why article
extraction stays with knowledge-engine's own proven JSDOM+Readability
code rather than being duplicated here.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .config import load_config
from .extract import ExtractError, fetch_html

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

config = load_config()
app = FastAPI()


class FetchResponse(BaseModel):
    html: str
    usedStealth: bool


@app.get("/fetch", response_model=FetchResponse)
def fetch_endpoint(url: str):
    # Plain def, not async - fetch_html() is synchronous/blocking (real
    # network I/O, and StealthyFetcher drives an actual browser process),
    # so a sync route handler lets FastAPI run it in its own thread pool
    # instead of blocking the event loop.
    try:
        html, used_stealth = fetch_html(config, url)
    except ExtractError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return FetchResponse(html=html, usedStealth=used_stealth)


@app.get("/health")
async def health():
    return {"status": "ok"}
