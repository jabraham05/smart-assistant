export interface Config {
  port: number;
  ollamaHost: string;
  sandboxRunnerUrl: string;
  plannerModel: string;
  coderModel: string;
  testerModel: string;
  reviewerModel: string;
  coderMaxIterations: number;
  testerMaxIterations: number;
  maxAttempts: number;
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
    // Same models already used by the coding_task_pipeline n8n workflow -
    // qwen3:14b for the deep-thinking Planner/Reviewer calls, qwen3:8b for
    // the tool-calling Coder/Tester agent loops.
    plannerModel: env.CODING_PLANNER_MODEL || "qwen3:14b",
    coderModel: env.CODING_CODER_MODEL || "qwen3:8b",
    testerModel: env.CODING_TESTER_MODEL || "qwen3:8b",
    reviewerModel: env.CODING_REVIEWER_MODEL || "qwen3:8b",
    coderMaxIterations: env.CODING_CODER_MAX_ITERATIONS ? Number(env.CODING_CODER_MAX_ITERATIONS) : 25,
    testerMaxIterations: env.CODING_TESTER_MAX_ITERATIONS ? Number(env.CODING_TESTER_MAX_ITERATIONS) : 15,
    maxAttempts: env.CODING_MAX_ATTEMPTS ? Number(env.CODING_MAX_ATTEMPTS) : 3,
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
    // Landing repo for from-scratch tasks with no existing target repo.
    // Optional - a from-scratch task with no configured fallback simply
    // can't run (createTaskContainer requires the primary or a fallback).
    codingTasksRepoUrl: env.CODING_TASKS_REPO_URL || undefined,
    gitAuthorName: env.GIT_AUTHOR_NAME || "smart-assistant-bot",
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL || "smart-assistant-bot@users.noreply.github.com",
  };
}
