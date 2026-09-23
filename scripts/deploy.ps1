# Pulls the latest main and rebuilds/restarts this repo's own services -
# the PowerShell twin of deploy.sh, for running straight from a normal
# PowerShell prompt (plain `bash scripts/deploy.sh` can resolve to the
# WSL bash shim instead of Git Bash on some machines, depending on PATH
# order - this avoids that entirely). Usage: .\scripts\deploy.ps1
#
# --force-recreate is required, not optional: `docker compose up --build`
# alone rebuilds the image but does NOT recreate a running container just
# because its image changed (compose only recreates on a config-hash
# change, e.g. env/volumes/image tag - a same-tag rebuild doesn't count).
# Found live: a deploy without it left the old container running the old
# code despite a successful build.

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

# Only services this repo builds from source - image-only infra
# (postgres, redis, ollama, ollama-warmup, n8n, homeassistant) never
# changes on a code deploy, so force-recreating them would just bounce
# stateful services for no reason.
$Services = @(
  "event-bus",
  "knowledge-engine",
  "memory-engine",
  "chat-orchestrator",
  "chat-orchestrator-test",
  "chat-ui",
  "skills-mcp",
  "sandbox-runner",
  "coding-orchestrator",
  "discord-bot"
)

Write-Host "==> Checking working tree"
$dirty = git status --porcelain --untracked-files=no
if ($dirty) {
  Write-Host "Refusing to deploy: uncommitted tracked changes here. Commit, stash, or discard them first." -ForegroundColor Red
  git status --short --untracked-files=no
  exit 1
}

$currentBranch = git rev-parse --abbrev-ref HEAD
if ($currentBranch -ne "main") {
  Write-Host "Refusing to deploy: on branch '$currentBranch', not main." -ForegroundColor Red
  exit 1
}

Write-Host "==> Pulling origin/main"
git fetch origin
if ($LASTEXITCODE -ne 0) { exit 1 }
git merge --ff-only origin/main
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "==> Building and restarting: $($Services -join ' ')"
docker compose up -d --build --force-recreate @Services
if ($LASTEXITCODE -ne 0) { exit 1 }

$sha = git rev-parse --short HEAD
$msg = git log -1 --pretty=%s
Write-Host "==> Deployed ${sha}: $msg"
docker compose ps @Services
