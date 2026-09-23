FROM node:22-alpine AS deps
WORKDIR /app
COPY chat-ui/package.json chat-ui/package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY chat-ui/. .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Docs are baked in at build time rather than bind-mounted at runtime - same
# reasoning (and the same Docker Desktop bind-mount gotcha) as the retired
# ops-dashboard's Dockerfile had. This build context is the repo root
# specifically so these paths (outside chat-ui's own directory) are
# reachable at all - see docker-compose.yml's chat-ui service.
COPY --chown=nextjs:nodejs docs ./docs
COPY --chown=nextjs:nodejs README.md ./docs/readme.md

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
