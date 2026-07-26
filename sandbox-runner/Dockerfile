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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Deliberately runs as root (no USER switch, unlike skills-mcp): it needs to
# read /var/run/docker.sock, whose group ownership/GID varies by host and
# isn't knowable at build time. This container never executes untrusted
# code directly — it only talks to the Docker API to spawn the actual
# sandboxed containers, which ARE locked down (non-root, no docker.sock,
# resource-capped, isolated network). Keeping this asymmetry visible here
# rather than hiding it is the point.
EXPOSE 3002
ENV PORT=3002
CMD ["node", "dist/index.js"]
