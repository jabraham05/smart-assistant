export interface Config {
  port: number;
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  // n8n_chat_histories lives in n8n's own database, not events - notify
  // writes there directly, same as coding-orchestrator's notify.ts does.
  n8nDatabase: string;
  honchoApiKey?: string;
  honchoWorkspaceId: string;
  // How many days of no goal_progress_log activity before the nudge
  // workflow considers a goal stale.
  goalStaleDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const postgresPassword = env.POSTGRES_PASSWORD;
  if (!postgresPassword) {
    throw new Error("POSTGRES_PASSWORD is required");
  }

  return {
    port: env.PORT ? Number(env.PORT) : 3004,
    postgres: {
      host: env.POSTGRES_HOST || "postgres",
      port: env.POSTGRES_PORT ? Number(env.POSTGRES_PORT) : 5432,
      // Dedicated database, same precedent as `research`/`coding_tasks`.
      database: env.EVENT_BUS_DB_NAME || "events",
      user: env.POSTGRES_USER || "assistant",
      password: postgresPassword,
    },
    n8nDatabase: env.N8N_DB_NAME || "n8n",
    // Optional, not required at startup: notifySession() skips the Honcho
    // call (but still writes to n8n_chat_histories) if this is unset, same
    // "clear degradation, not a crash" pattern used everywhere else.
    honchoApiKey: env.HONCHO_API_KEY || undefined,
    honchoWorkspaceId: env.HONCHO_WORKSPACE_ID || "smart-assistant",
    goalStaleDays: env.GOAL_STALE_DAYS ? Number(env.GOAL_STALE_DAYS) : 7,
  };
}
