#!/bin/sh
set -e

# Docker Desktop's Windows bind-mount translation always presents a
# host-side directory as root:root inside the container, regardless of
# chmod attempted from the Windows side (verified live - a plain `chmod 777`
# on the host had no effect on the in-container listing) - so the
# KNOWLEDGE_STORE_PATH mount (see docker-compose.yml) is unwritable by the
# non-root knowledgeengine user without this fix-up. Runs as root only for
# this one chown, then drops to knowledgeengine via su-exec for the actual
# process - same "root never runs the application code" stance the
# Dockerfile's removed USER directive used to enforce directly.
if [ -d "$KNOWLEDGE_STORE_PATH" ]; then
  chown -R knowledgeengine:knowledgeengine "$KNOWLEDGE_STORE_PATH"
fi

exec su-exec knowledgeengine "$@"
