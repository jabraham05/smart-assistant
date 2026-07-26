# Minimal base image for ephemeral sandbox containers running Node-based
# test suites. node:22-alpine has no git; the ephemeral container needs it
# to clone the target repo. Installed here (as root, at build time) so the
# ephemeral containers themselves never need root or package-install
# capability at runtime — they just run as the unprivileged `node` user.
FROM node:22-alpine
RUN apk add --no-cache git
USER node
WORKDIR /work
