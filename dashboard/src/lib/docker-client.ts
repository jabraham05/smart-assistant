import Docker from "dockerode";

// Matches docker-compose.yml's actual service list. Static rather than
// discovered dynamically - simpler, and avoids the dashboard needing to
// filter out ephemeral sandbox-runner-spawned containers on sandbox-net.
export const COMPOSE_SERVICES = [
  "n8n",
  "ollama",
  "chat-ui",
  "homeassistant",
  "postgres",
  "redis",
  "skills-mcp",
  "sandbox-runner",
  "coding-orchestrator",
  "event-bus",
  "knowledge-engine",
  "discord-bot",
  "dashboard",
] as const;

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });

// Resolves by the com.docker.compose.service label rather than a hardcoded
// "<project>-<service>-1" name - the project name (`name: assistant` in
// docker-compose.yml) could vary across environments/checkouts, but the
// Compose-applied label is always accurate.
export async function getContainerLogs(service: string, tail = 200): Promise<string> {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`com.docker.compose.service=${service}`] }),
  });

  const containerInfo = containers[0];
  if (!containerInfo) {
    throw new Error(`No running container found for service "${service}"`);
  }

  const container = docker.getContainer(containerInfo.Id);
  const buffer = (await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  })) as unknown as Buffer;

  return demuxDockerLogBuffer(buffer);
}

// docker.logs() over the Engine API returns a multiplexed stream when the
// container wasn't started with a TTY (true for every service here) - each
// frame is an 8-byte header (1 byte stream type, 3 reserved, 4 byte length)
// followed by that many bytes of actual log text. Strip the headers rather
// than passing the raw buffer straight to the UI as text.
function demuxDockerLogBuffer(buffer: Buffer): string {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) break;
    lines.push(buffer.subarray(start, end).toString("utf8"));
    offset = end;
  }
  // Fall back to raw text if demuxing didn't consume the whole buffer
  // (e.g. a TTY-attached container, which isn't multiplexed) - better to
  // show something than nothing.
  if (offset < buffer.length && lines.length === 0) {
    return buffer.toString("utf8");
  }
  return lines.join("");
}
