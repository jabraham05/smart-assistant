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
RUN addgroup --system --gid 1001 knowledgeengine && adduser --system --uid 1001 knowledgeengine
# su-exec - lets docker-entrypoint.sh drop from root to knowledgeengine
# after fixing up the KNOWLEDGE_STORE_PATH bind mount's ownership (see that
# script's comment for why this step exists).
RUN apk add --no-cache su-exec
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder --chown=knowledgeengine:knowledgeengine /app/dist ./dist
COPY docker-entrypoint.sh ./
RUN chmod +x ./docker-entrypoint.sh

# Never touches docker.sock or any external secret-bearing API directly -
# the application process itself still runs as non-root like every other
# service in this project; root here is only the entrypoint's brief
# chown step before it execs into knowledgeengine (see docker-entrypoint.sh).
EXPOSE 3005
ENV PORT=3005
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
