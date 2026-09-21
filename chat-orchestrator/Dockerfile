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
RUN addgroup --system --gid 1001 orchestrator && adduser --system --uid 1001 orchestrator
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder --chown=orchestrator:orchestrator /app/dist ./dist

# Never touches docker.sock or any host resource directly - only talks to
# skills-mcp/Ollama/Postgres/Redis/Honcho over the network - so it runs as
# non-root like every other application service in this project.
USER orchestrator
EXPOSE 3006
ENV PORT=3006
CMD ["node", "dist/index.js"]
