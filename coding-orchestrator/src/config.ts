export interface Config {
  port: number;
  ollamaHost: string;
  sandboxRunnerUrl: string;
  // Phase 2 of the infrastructure rebuild - off by default. When true,
  // existing-repo tasks (from-scratch tasks still need sandbox-runner's
  // template-seeding, which openhands-runner doesn't implement) run their
  // Coder/Tester round through openhands-runner instead of this file's own
  // hand-rolled agent-loop. Kept behind a flag, not a hard cutover, so the
  // already-proven sandbox-runner path stays the live default through a
  // soak period - same rollout shape Phase 1 (agent-service) used before
  // chat-orchestrator was ever pointed away from.
  useOpenHandsRunner: boolean;
  openhandsRunnerUrl: string;
  plannerModel: string;
  coderModel: string;
  testerModel: string;
  reviewerModel: string;
  coderMaxIterations: number;
  testerMaxIterations: number;
  maxAttempts: number;
  // Real, evidenced gap (task #53): an infra-class failure (Coder/Tester
  // producing no output even after their own inline retry - see
  // runCoderRound/runTesterRound) used to consume a real attempt slot
  // identically to a genuine Reviewer rejection, even though it carries
  // zero signal about the actual code. Lets runTaskPipeline's outer loop
  // retry the SAME attempt number up to this many times on an infra-class
  // failure before falling back to charging a real attempt - bounded, same
  // "can't loop forever" spirit as the CommandLimitExceededError hard-stop
  // a few lines below it in pipeline.ts.
  maxInfraRetries: number;
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  // n8n_chat_histories lives in n8n's own database, not coding_tasks - the
  // notify step writes there directly, same as Notify Chat History used to.
  n8nDatabase: string;
  honchoApiKey?: string;
  honchoWorkspaceId: string;
  // Always-on internal infra, same tier as sandboxRunnerUrl - not a
  // per-user optional integration, so it gets a real default rather than
  // `|| undefined`.
  eventBusUrl: string;
  codingTasksRepoUrl?: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const postgresPassword = env.POSTGRES_PASSWORD;
  if (!postgresPassword) {
    throw new Error("POSTGRES_PASSWORD is required");
  }

  return {
    port: env.PORT ? Number(env.PORT) : 3003,
    ollamaHost: env.OLLAMA_HOST || "http://ollama:11434",
    sandboxRunnerUrl: env.SANDBOX_RUNNER_URL || "http://sandbox-runner:3002",
    useOpenHandsRunner: env.USE_OPENHANDS_RUNNER === "true",
    openhandsRunnerUrl: env.OPENHANDS_RUNNER_URL || "http://openhands-runner:3011",
    // All four roles consolidated onto qwen3.5:9b - Planner/Reviewer used
    // to run the bigger qwen3:14b (inherited from the old
    // coding_task_pipeline n8n workflow's split), Coder/Tester qwen3:8b.
    // Live benchmarking (scripts/benchmark-results/, including a real
    // execution-verified agentic task, not just regex-graded one-liners)
    // showed qwen3.5:9b matching or beating qwen3:14b's output quality
    // while being meaningfully faster. Consolidating to one model everywhere
    // also eliminates the VRAM-swap cost between two differently-sized
    // models that don't both fit in 12GB at once - see ollama.ts's keepAlive
    // comment and the Planner/Reviewer call sites in pipeline.ts, which
    // only apply the short self-evict keepAlive when a role's configured
    // model actually differs from coderModel.
    plannerModel: env.CODING_PLANNER_MODEL || "qwen3.5:9b",
    coderModel: env.CODING_CODER_MODEL || "qwen3.5:9b",
    testerModel: env.CODING_TESTER_MODEL || "qwen3.5:9b",
    reviewerModel: env.CODING_REVIEWER_MODEL || "qwen3.5:9b",
    coderMaxIterations: env.CODING_CODER_MAX_ITERATIONS ? Number(env.CODING_CODER_MAX_ITERATIONS) : 25,
    testerMaxIterations: env.CODING_TESTER_MAX_ITERATIONS ? Number(env.CODING_TESTER_MAX_ITERATIONS) : 15,
    maxAttempts: env.CODING_MAX_ATTEMPTS ? Number(env.CODING_MAX_ATTEMPTS) : 3,
    maxInfraRetries: env.CODING_MAX_INFRA_RETRIES ? Number(env.CODING_MAX_INFRA_RETRIES) : 2,
    postgres: {
      host: env.POSTGRES_HOST || "postgres",
      port: env.POSTGRES_PORT ? Number(env.POSTGRES_PORT) : 5432,
      // Dedicated database, same precedent as `research` - not the `n8n`
      // database, and not reusing the old codingproposals1 Data Table.
      database: env.CODING_TASKS_DB_NAME || "coding_tasks",
      user: env.POSTGRES_USER || "assistant",
      password: postgresPassword,
    },
    n8nDatabase: env.N8N_DB_NAME || "n8n",
    // Optional, not required at startup: notifyOrigin() skips the Honcho
    // call (but still writes to n8n_chat_histories) if this is unset,
    // same "clear degradation, not a crash" pattern used everywhere else.
    honchoApiKey: env.HONCHO_API_KEY || undefined,
    honchoWorkspaceId: env.HONCHO_WORKSPACE_ID || "smart-assistant",
    eventBusUrl: env.EVENT_BUS_URL || "http://event-bus:3004",
    // Landing repo for from-scratch tasks with no existing target repo.
    // Optional - a from-scratch task with no configured fallback simply
    // can't run (createTaskContainer requires the primary or a fallback).
    codingTasksRepoUrl: env.CODING_TASKS_REPO_URL || undefined,
    gitAuthorName: env.GIT_AUTHOR_NAME || "smart-assistant-bot",
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL || "smart-assistant-bot@users.noreply.github.com",
  };
}
