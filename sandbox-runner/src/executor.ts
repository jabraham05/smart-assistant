import Docker from "dockerode";
import type { Config } from "./config.js";

export interface ExecuteRequest {
  repoUrl: string;
  ref?: string;
  patch?: string; // unified diff, plain text (not yet exercised — Phase 1 has no diff step)
  testCommand: string;
  timeoutSeconds?: number;
}

export interface ExecuteResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// Docker multiplexes stdout/stderr into one stream when Tty is false: each
// frame is an 8-byte header (stream type + big-endian uint32 size) followed
// by that many bytes of payload. Demuxing manually here avoids needing the
// stream-based modem.demuxStream helper for what `container.logs()` already
// hands back as a single Buffer in non-follow mode.
function demuxLogs(buffer: Buffer): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    const chunk = buffer.subarray(start, end).toString("utf8");
    if (streamType === 2) {
      stderr += chunk;
    } else {
      stdout += chunk;
    }
    offset = end;
  }
  return { stdout, stderr };
}

// The script run inside the ephemeral container. repoUrl/ref/testCommand/
// patch are passed as env vars (not interpolated into the script text) so
// arbitrary characters in a test command never need shell-escaping here —
// this script only ever runs inside the disposable, network-isolated,
// resource-capped container, never on the host.
const RUN_SCRIPT = `set -o pipefail
git clone --depth 1 --branch "$REF" "$REPO_URL" /work/repo
cd /work/repo || exit 1
if [ -n "$PATCH_B64" ]; then
  echo "$PATCH_B64" | base64 -d > /tmp/patch.diff
  patch -p1 --fuzz=3 --no-backup-if-mismatch < /tmp/patch.diff
  echo "PATCH_APPLY_EXIT_CODE:$?" >&2
fi
eval "$TEST_COMMAND"
`;

export async function runInSandbox(
  config: Config,
  req: ExecuteRequest,
): Promise<ExecuteResult> {
  const docker = new Docker({ socketPath: config.dockerSocketPath });
  const startTime = Date.now();

  const container = await docker.createContainer({
    Image: config.nodeImage,
    Cmd: ["sh", "-c", RUN_SCRIPT],
    Env: [
      `REPO_URL=${req.repoUrl}`,
      `REF=${req.ref ?? "main"}`,
      `TEST_COMMAND=${req.testCommand}`,
      ...(req.patch ? [`PATCH_B64=${Buffer.from(req.patch, "utf8").toString("base64")}`] : []),
    ],
    Tty: false,
    HostConfig: {
      // Never `assistant-net` — no legitimate reason for sandboxed code to
      // reach postgres/n8n/ollama/Honcho. docker.sock is never mounted here.
      NetworkMode: config.sandboxNetwork,
      Memory: config.memoryLimitBytes,
      NanoCpus: config.nanoCpus,
      PidsLimit: config.pidsLimit,
      Privileged: false,
      AutoRemove: false, // removed manually below, after logs are captured
    },
  });

  let timedOut = false;
  let timer: NodeJS.Timeout;
  const timeoutMs = (req.timeoutSeconds ?? config.defaultTimeoutSeconds) * 1000;

  try {
    await container.start();

    const waitPromise = container.wait();
    const timeoutPromise = new Promise<{ StatusCode: number }>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        container.kill().catch(() => {});
        resolve({ StatusCode: -1 });
      }, timeoutMs);
    });

    const result = (await Promise.race([waitPromise, timeoutPromise])) as { StatusCode: number };
    clearTimeout(timer!);

    const logsBuffer = (await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    })) as unknown as Buffer;
    const { stdout, stderr } = demuxLogs(logsBuffer);

    return {
      exitCode: timedOut ? null : result.StatusCode,
      stdout,
      stderr,
      timedOut,
      durationMs: Date.now() - startTime,
    };
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}
