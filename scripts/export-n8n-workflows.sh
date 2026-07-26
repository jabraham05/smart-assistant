#!/usr/bin/env bash
# Exports all n8n workflows as JSON into n8n/workflows/ for version control.
# Run after editing workflows in the n8n UI.
#
# Uses `docker cp` instead of the bind-mounted volume: on this machine, Docker
# Desktop's WSL2 bind mounts have repeatedly gone stale/unreadable (see
# memory: onedrive-docker-incompatible) even outside OneDrive and after a
# full container recreate. docker cp reads the container's filesystem
# directly and isn't subject to that.
#
# --published is required: without it, this pulls the *draft* version, which
# silently diverges from what's actually live whenever a workflow was last
# changed via the CLI import/publish cycle (draft and published are separate
# n8n internals) rather than saved through the UI. Learned the hard way when
# this exported a workflow missing nodes that were confirmed live and working.
#
# `--all --published` together is ALSO unreliable on this n8n version
# (2.31.6) — it silently returned stale content for a workflow that
# `--id=X --published` (single-workflow form) correctly showed as current,
# for reasons not otherwise diagnosed. Exporting each workflow individually
# by ID with `--published` is the form proven to actually return live
# content, so that's what this script does instead of `--all`.
#
# On this machine's Git Bash, any `/tmp/...`-style argument gets silently
# rewritten to a Windows path before reaching `docker`/`docker compose`
# (MSYS path conversion) — the container then gets a nonsense path and every
# export fails with ENOENT. MSYS_NO_PATHCONV=1 disables that rewrite; it's a
# no-op on real Linux/macOS shells, so safe to always set.
export MSYS_NO_PATHCONV=1
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p n8n/workflows
docker compose exec -T n8n rm -rf /home/node/.n8n-exports
docker compose exec -T n8n mkdir -p /home/node/.n8n-exports

# list:workflow prints "<id>|<name>" per line, one per workflow. Some
# workflows in this project (e.g. the empty `update_context` stub) have
# never been published, so --published errors for them — fall back to the
# draft export in that case rather than aborting the whole run.
#
# Captured into a variable first, not piped straight into `while read`: even
# with `-T` (no pseudo-tty), `docker compose exec` still leaves the
# container process's stdin attached to the host's stdin by default, so the
# inner exec calls silently consume the remaining lines of a piped `while
# read` and the loop dies after one iteration. Reading from an
# already-captured variable via a here-string, PLUS `</dev/null` on every
# inner docker call, avoids the shared-stdin problem entirely.
#
# --separate (even for a single --id) is what produces a bare workflow
# object per file; without it, --output=file.json wraps the result in a
# single-element JSON array, which doesn't match this repo's existing
# snapshot format.
workflow_list="$(docker compose exec -T n8n n8n list:workflow </dev/null | tr -d '\r')"
while IFS='|' read -r id name; do
  [ -z "$id" ] && continue
  if ! docker compose exec -T n8n n8n export:workflow --id="$id" --published --separate --output=/home/node/.n8n-exports/ </dev/null 2>/dev/null; then
    echo "No published version for ${name} (${id}); exporting draft instead" >&2
    docker compose exec -T n8n n8n export:workflow --id="$id" --separate --output=/home/node/.n8n-exports/ </dev/null
  fi
done <<< "$workflow_list"

# Copy files one at a time, not the whole directory in one `docker cp` — a
# single wildcard/directory copy (`docker cp container:/dir/. dest/`) has
# silently copied nothing on this machine (exits 0, dest left untouched)
# without `set -e` catching it, matching this project's known docker
# cp/bind-mount flakiness. Per-file copies have been reliable.
for f in $(docker compose exec -T n8n sh -c 'ls /home/node/.n8n-exports' </dev/null); do
  f="${f%$'\r'}"
  docker cp "assistant-n8n-1:/home/node/.n8n-exports/${f}" "n8n/workflows/${f}"
done

docker compose exec -T n8n rm -rf /home/node/.n8n-exports </dev/null
