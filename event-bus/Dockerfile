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
RUN addgroup --system --gid 1001 eventbus && adduser --system --uid 1001 eventbus
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder --chown=eventbus:eventbus /app/dist ./dist

# Never touches docker.sock or any external secret-bearing API directly -
# runs as non-root like every other application service in this project.
USER eventbus
EXPOSE 3004
ENV PORT=3004
CMD ["node", "dist/index.js"]
