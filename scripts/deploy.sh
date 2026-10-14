#!/usr/bin/env bash
# Pulls the latest main and rebuilds/restarts this repo's own services -
# the redeploy step after merging a PR, run from the primary checkout
# (not a worktree). Usage: bash scripts/deploy.sh
#
# --force-recreate is required, not optional: `docker compose up --build`
# alone rebuilds the image but does NOT recreate a running container just
# because its image changed (compose only recreates on a config-hash
# change, e.g. env/volumes/image tag - a same-tag rebuild doesn't count).
# Found live: a deploy without it left the old container running the old
# code despite a successful build.
set -euo pipefail
cd "$(dirname "$0")/.."

# Only services this repo builds from source - image-only infra
# (postgres, redis, ollama, ollama-warmup, n8n, homeassistant) never
# changes on a code deploy, so force-recreating them would just bounce
# stateful services for no reason.
SERVICES=(
  event-bus
  knowledge-engine
  memory-engine
  agent-service
  chat-ui
  skills-mcp
  sandbox-runner
  coding-orchestrator
  discord-bot
)

echo "==> Checking working tree"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Refusing to deploy: uncommitted tracked changes here. Commit, stash, or discard them first." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "main" ]; then
  echo "Refusing to deploy: on branch '$current_branch', not main." >&2
  exit 1
fi

echo "==> Pulling origin/main"
git fetch origin
git merge --ff-only origin/main

echo "==> Building and restarting: ${SERVICES[*]}"
docker compose up -d --build --force-recreate "${SERVICES[@]}"

echo "==> Deployed $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"
docker compose ps "${SERVICES[@]}"
