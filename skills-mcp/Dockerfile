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
RUN addgroup --system --gid 1001 mcp && adduser --system --uid 1001 mcp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder --chown=mcp:mcp /app/dist ./dist
# Baked in at build time rather than bind-mounted at runtime - Docker
# Desktop on this Windows machine gets a single-file bind mount stuck
# as a directory at the container level (same issue hit with
# ollama-mcp-bridge's config file), persisting across container
# recreation. secrets/google-calendar-key.json is gitignored either
# way; only its location moved into this build context.
COPY --chown=mcp:mcp secrets/google-calendar-key.json /run/secrets/google-calendar-key.json

USER mcp
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/index.js"]
