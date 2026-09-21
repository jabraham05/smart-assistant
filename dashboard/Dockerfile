FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

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
