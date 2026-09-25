FROM python:3.12-slim AS base
WORKDIR /app
RUN pip install --no-cache-dir --upgrade pip

# scrapling itself (and its own browser install, below) installed BEFORE
# copying application source - live-verified this session: with source
# copied first, every unrelated src/ edit invalidated Docker's cache for
# `scrapling install` too, forcing a real ~237s rebuild (apt + a ~658MB
# browser download) for a one-line Python change. Ordered this way, that
# only re-runs when scrapling's own version changes.
RUN pip install --no-cache-dir 'scrapling[fetchers,rag]>=0.4.0'

# Real, live-verified requirement: StealthyFetcher (the fallback path, see
# extract.py) needs a real browser plus a substantial apt dependency set
# (fonts, X11, audio, DRM/GBM libs for headless rendering) - confirmed this
# session at ~658MB for the browser cache alone. Baked in at build time,
# not downloaded lazily on first fallback request, so the fallback path
# doesn't add a slow surprise the first time it's actually needed.
RUN scrapling install

COPY pyproject.toml ./
COPY src ./src
# --no-deps: scrapling and its extras are already installed above: this
# just installs the local package itself plus fastapi/uvicorn, which
# aren't affected by the ordering concern above.
RUN pip install --no-cache-dir --no-deps . && pip install --no-cache-dir 'fastapi>=0.115.0' 'uvicorn[standard]>=0.32.0'

# Never touches docker.sock or any host resource directly - only talks
# outbound to the pages it fetches - so it runs as non-root like every
# other application service in this project. Created after `scrapling
# install` (which needs root for apt-get), and the cache dir it wrote to
# is handed to this user so StealthyFetcher can still read the browser it
# just installed.
RUN groupadd --system scrapling && useradd --system --gid scrapling --create-home scrapling \
    && cp -r /root/.cache /home/scrapling/.cache \
    && chown -R scrapling:scrapling /home/scrapling/.cache
USER scrapling
ENV HOME=/home/scrapling

EXPOSE 3013
ENV PORT=3013
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "3013"]
