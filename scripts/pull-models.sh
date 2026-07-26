#!/usr/bin/env bash
# Pulls the local models the stack depends on:
#   llama3.1:8b      - tool-calling chat model used by n8n's AI Agent
#   nomic-embed-text - embedding model pulled for an abandoned self-hosted-Honcho
#                      attempt (see honcho-src/ note in README); not used by
#                      anything currently, since Honcho now runs hosted and its
#                      embeddings live in their cloud. Kept pulled in case
#                      self-hosting is ever revisited; safe to skip otherwise.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose exec ollama ollama pull llama3.1:8b
docker compose exec ollama ollama pull nomic-embed-text
