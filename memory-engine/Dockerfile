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
RUN addgroup --system --gid 1001 memoryengine && adduser --system --uid 1001 memoryengine
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder --chown=memoryengine:memoryengine /app/dist ./dist

USER memoryengine
EXPOSE 3007
ENV PORT=3007
CMD ["node", "dist/index.js"]
