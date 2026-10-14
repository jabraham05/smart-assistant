# Scrapling service

Part of the [Smart Assistant](../README.md) project. Phase 4 of the
"5-pillar rebuild" (PydanticAI → OpenHands → Graphiti → Scrapling → DSPy)
documented in [`docs/dspy-optimizer.md`](dspy-optimizer.md) and tracked
from the architecture side in
[`docs/unified-architecture-gap-analysis.md`](unified-architecture-gap-analysis.md).
Live, with a real caller, but not otherwise documented anywhere until this
file — also missing from the README's directory layout (see that doc's own
gap list).

**What it is**: a small FastAPI wrapper (`scrapling-service/`,
internal-only, no published port, reached at `http://scrapling-service:3013`)
around the [Scrapling](https://github.com/D4Vinci/Scrapling) library,
giving `knowledge-engine` a real page-fetch step with JS rendering and
anti-bot evasion — something a plain `fetch()` never had. `GET
/fetch?url=` tries `Fetcher` first (no browser, cheap); only on a
blocked/failed response (403/429/503, or a thrown exception) does it
retry with `StealthyFetcher` (a real, live-verified ~658MB headless
browser footprint — fonts/X11/audio/DRM libs baked into the image at
build time, not downloaded lazily, so the fallback path doesn't add a
slow surprise the first time it's actually needed; see `Dockerfile`).
Returns `{ html, usedStealth }` — raw HTML, not pre-extracted article
content.

**Why raw HTML, not extracted text**: a real, live-verified finding while
building this — Scrapling's own `.markdown()` conversion
(`main_content_only=True`) does *not* do Readability-style boilerplate
stripping; it only means "convert what's inside `<body>`, not `<head>`."
Tested against a real Wikipedia article, it returned the nav sidebar, not
the article. Scrapling's genuine value here is reliable fetching, not
content extraction — so `src/extract.py` hands back raw HTML and lets
`knowledge-engine`'s own already-proven JSDOM+Readability pipeline
(`knowledge-engine/src/lib/html-extract.ts`) do the actual extraction, the
same code path it already used for the plain-`fetch()` case, just fed
better-fetched HTML now.

**The only caller**: `knowledge-engine/src/lib/html-extract.ts`'s
`extractUrl`, via `SCRAPLING_SERVICE_URL` (`knowledge-engine/src/config.ts`,
default `http://scrapling-service:3013`). Not a hard dependency — a failed
or unreachable `scrapling-service` falls back to `knowledge-engine`'s own
plain `fetch()` + a `User-Agent` header, same "clear degradation, not a
crash" pattern used everywhere else in this project. Feeds both document
ingestion (`engine/ingest.ts`) and the web-research agent
(`engine/research-agent.ts`).

## Known rough edges

- `StealthyFetcher` is a fallback, not the default, specifically because
  of its ~658MB footprint on a machine with already-documented resource
  contention (see [`docs/known-gotchas.md`](known-gotchas.md)) — if the
  plain `Fetcher` path proves insufficient often enough in practice,
  switching the default is a deliberate future revisit, not a forgotten
  limitation.
- No automated tests. Like `sandbox-runner`/`coding-orchestrator`'s
  original state, verification here has been manual/live against the real
  stack so far, not a real test suite.
