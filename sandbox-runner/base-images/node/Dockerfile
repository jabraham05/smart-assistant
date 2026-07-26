# Minimal base image for ephemeral sandbox containers running Node-based
# test suites. node:22-alpine has no git; the ephemeral container needs it
# to clone the target repo. Installed here (as root, at build time) so the
# ephemeral containers themselves never need root or package-install
# capability at runtime — they just run as the unprivileged `node` user.
FROM node:22-alpine
# git: needed to clone the target repo.
# patch: applying LLM-generated diffs with `git apply` is too strict in
# practice (a real, observed failure mode: models producing near-correct
# but not byte-perfect unified diffs, e.g. missing a newline between the
# ---/+++ header lines) — `patch -p1 --fuzz` tolerates exactly this kind
# of imperfection via context-based fuzzy matching, which git apply does not.
RUN apk add --no-cache git patch
USER node
WORKDIR /work
