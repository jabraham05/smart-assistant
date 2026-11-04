#!/usr/bin/env bash
# Imports every workflow JSON in n8n/workflows/ into a running n8n
# instance. Mirror of export-n8n-workflows.sh, for the other direction -
# needed by scripts/reset-everything.mjs to restore workflows after a full
# postgres-data wipe (a fresh n8n database has no workflows at all until
# this runs).
#
# Same docker-cp-not-bind-mount reasoning as the export script (see its
# comments) applies here too - copy files INTO the container rather than
# relying on a bind mount that's been unreliable on this machine.
export MSYS_NO_PATHCONV=1
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d n8n/workflows ] || [ -z "$(ls -A n8n/workflows 2>/dev/null)" ]; then
  echo "n8n/workflows/ is empty or missing - nothing to import" >&2
  exit 1
fi

docker compose exec -T n8n rm -rf /home/node/.n8n-imports </dev/null
docker compose exec -T n8n mkdir -p /home/node/.n8n-imports </dev/null

for f in n8n/workflows/*.json; do
  name="$(basename "$f")"
  docker cp "$f" "assistant-n8n-1:/home/node/.n8n-imports/${name}"
done

# --separate --input=<dir> imports every workflow file in the directory in
# one call (same flag pairing export-workflow.sh uses, just inverted).
docker compose exec -T n8n n8n import:workflow --separate --input=/home/node/.n8n-imports/ </dev/null

docker compose exec -T n8n rm -rf /home/node/.n8n-imports </dev/null
echo "Imported $(ls n8n/workflows/*.json | wc -l | tr -d ' ') workflow file(s) into n8n."
