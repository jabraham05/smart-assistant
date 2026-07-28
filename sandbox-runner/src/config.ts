export interface Config {
  port: number;
  dockerSocketPath: string;
  sandboxNetwork: string;
  nodeImage: string;
  defaultTimeoutSeconds: number;
  memoryLimitBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  githubToken?: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  // Persistent task-container settings (agentic coding pipeline). Isolation
  // (network/user/privileged/resource caps) is identical to the ephemeral
  // path above - these only govern lifecycle/cleanup for a longer-lived
  // container, and per-exec-call bounds within it.
  taskContainerIdleTimeoutSeconds: number;
  taskContainerMaxLifetimeSeconds: number;
  reaperIntervalSeconds: number;
  execDefaultTimeoutSeconds: number;
  execMaxTimeoutSeconds: number;
  maxCommandsPerTask: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: env.PORT ? Number(env.PORT) : 3002,
    dockerSocketPath: env.DOCKER_SOCKET_PATH || "/var/run/docker.sock",
    // Ephemeral per-task containers join this network, never `assistant-net`
    // — they have no legitimate reason to reach postgres/n8n/ollama/Honcho.
    sandboxNetwork: env.SANDBOX_NETWORK || "sandbox-net",
    // Built from base-images/node/Dockerfile: node:22-alpine + git, non-root.
    nodeImage: env.SANDBOX_NODE_IMAGE || "sandbox-node-test:latest",
    defaultTimeoutSeconds: env.SANDBOX_TIMEOUT_SECONDS
      ? Number(env.SANDBOX_TIMEOUT_SECONDS)
      : 120,
    memoryLimitBytes: env.SANDBOX_MEMORY_MB
      ? Number(env.SANDBOX_MEMORY_MB) * 1024 * 1024
      : 512 * 1024 * 1024,
    nanoCpus: env.SANDBOX_CPUS ? Number(env.SANDBOX_CPUS) * 1e9 : 1e9,
    pidsLimit: env.SANDBOX_PIDS_LIMIT ? Number(env.SANDBOX_PIDS_LIMIT) : 256,
    // Deliberately kept here, never passed through n8n workflow parameters:
    // n8n stores full execution data (every node's inputs/outputs) in
    // Postgres in plaintext, so a token flowing through a workflow's JSON
    // body would sit there indefinitely. Only this service ever sees it -
    // the workflow just asks "push and open a PR", never touches the token.
    githubToken: env.GITHUB_TOKEN || undefined,
    gitAuthorName: env.GIT_AUTHOR_NAME || "smart-assistant-bot",
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL || "smart-assistant-bot@users.noreply.github.com",
    taskContainerIdleTimeoutSeconds: env.TASK_CONTAINER_IDLE_TIMEOUT_SECONDS
      ? Number(env.TASK_CONTAINER_IDLE_TIMEOUT_SECONDS)
      : 300,
    taskContainerMaxLifetimeSeconds: env.TASK_CONTAINER_MAX_LIFETIME_SECONDS
      ? Number(env.TASK_CONTAINER_MAX_LIFETIME_SECONDS)
      : 1800,
    reaperIntervalSeconds: env.REAPER_INTERVAL_SECONDS ? Number(env.REAPER_INTERVAL_SECONDS) : 60,
    execDefaultTimeoutSeconds: env.EXEC_DEFAULT_TIMEOUT_SECONDS
      ? Number(env.EXEC_DEFAULT_TIMEOUT_SECONDS)
      : 30,
    execMaxTimeoutSeconds: env.EXEC_MAX_TIMEOUT_SECONDS ? Number(env.EXEC_MAX_TIMEOUT_SECONDS) : 120,
    maxCommandsPerTask: env.MAX_COMMANDS_PER_TASK ? Number(env.MAX_COMMANDS_PER_TASK) : 100,
  };
}
