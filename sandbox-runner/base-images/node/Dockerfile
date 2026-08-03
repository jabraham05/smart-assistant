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
# python3/py3-pip: the persistent-container coding pipeline (Coder/Tester
# agents with real shell access) isn't Node-only in practice — a real
# from-scratch task asked for a Python CLI script, and the Tester couldn't
# even run it to verify, let alone test it, with no interpreter present.
# This image is still the one shared base for every task regardless of
# language (no per-task image selection exists yet, still deliberately
# deferred - see README), so it needs to cover the common case, not just
# Node.
RUN apk add --no-cache git patch python3 py3-pip
USER node
WORKDIR /work
