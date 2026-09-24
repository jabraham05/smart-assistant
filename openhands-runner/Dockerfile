FROM python:3.12-slim AS base
WORKDIR /app

# Real, live-verified finding: DockerWorkspace shells out to the real
# `docker` CLI binary itself (subprocess.Popen(["docker", "version"], ...))
# rather than talking to the Engine API purely in-process - unlike
# sandbox-runner's dockerode (a pure JS client needing only the socket).
# Second real finding: Debian trixie's `docker.io` apt package ships only
# dockerd/docker-proxy/docker-init, not the `docker` CLI client itself
# (confirmed via dpkg -L) - Docker's own static CLI binary is simpler and
# more reliable here than pulling in Docker's full APT repo + GPG key setup
# for a client-only need; no daemon runs in this container, it just talks
# to the mounted host socket.
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.3.1.tgz | tar -xz -C /tmp \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && rm -rf /tmp/docker \
    && docker --version

RUN pip install --no-cache-dir --upgrade pip

COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

# Unlike agent-service/sandbox-runner, this service cannot run as a
# non-root, no-docker-access user - DockerWorkspace itself needs to talk to
# the Docker daemon to launch the agent-server container it drives (same
# reason sandbox-runner mounts docker.sock into itself, never into the
# containers it spawns - see docker-compose.yml's comment on that service).
EXPOSE 3011
ENV PORT=3011
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "3011"]
