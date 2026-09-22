FROM node:22-alpine AS deps
WORKDIR /app
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY dashboard/. .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Docs are baked in at build time rather than bind-mounted at runtime -
# confirmed live that both a single-file mount and a directory mount get
# stuck as empty on this machine's Docker Desktop (the same failure mode
# already documented for skills-mcp's Google Calendar key file). This build
# context is the repo root specifically so these paths (outside
# dashboard/'s own directory) are reachable at all - every other Dockerfile
# in this repo uses its own subdirectory as context, but this service is
# the one exception that genuinely needs files from outside it.
COPY docs ./docs
COPY README.md ./docs/readme.md

# Deliberately runs as root (no USER switch, unlike chat-ui): it needs to
# read /var/run/docker.sock for the Logs panel, whose group ownership/GID
# varies by host and isn't knowable at build time. Same asymmetry and same
# reasoning as sandbox-runner/Dockerfile - this container only reads
# container logs and metadata via the Docker API, it never spawns or execs
# into anything.
EXPOSE 3006
ENV PORT=3006
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
