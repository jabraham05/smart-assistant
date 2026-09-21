export interface Config {
  port: number;
  ollamaHost: string;
  chatModel: string;
  classifierModel: string;
  agentMaxIterations: number;
  numCtx: number;
  skillsMcpUrl: string;
  postgres: {
    host: string;
    port: number;
    // Personas/skills live in n8n's own database (the underlying physical
    // tables backing its Data Table feature) - same database
    // coding-orchestrator's notify.ts already reads/writes directly.
    n8nDatabase: string;
    user: string;
    password: string;
  };
  // 'public' (the real views onto n8n's live Data Tables, see
  // postgres/init/10-add-chat-test-schema.sql) for the production
  // instance, 'chat_test' for the side-by-side test instance - lets a
  // persona/skill change be tried safely before it's promoted into the
  // real n8n Data Table. Deliberately just a schema name, not a whole
  // second connection - same Postgres server/database either way.
  dbSchema: string;
  redis: {
    host: string;
    port: number;
    // 0 for the production instance, 1 for the test instance - keeps
    // session buffers from ever colliding between the two, without a key
    // prefix scheme to maintain by hand.
    db: number;
  };
  honchoApiKey?: string;
  honchoWorkspaceId: string;
  eventBusUrl: string;
  memoryEngineUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const postgresPassword = env.POSTGRES_PASSWORD;
  if (!postgresPassword) {
    throw new Error("POSTGRES_PASSWORD is required");
  }

  return {
    port: env.PORT ? Number(env.PORT) : 3006,
    ollamaHost: env.OLLAMA_HOST || "http://ollama:11434",
    // Same model the old Chat workflow's AI Agent used - this migration is
    // about the orchestration mechanism, not a model swap.
    chatModel: env.CHAT_MODEL || "qwen3:8b",
    classifierModel: env.CHAT_CLASSIFIER_MODEL || "qwen3:8b",
    agentMaxIterations: env.CHAT_AGENT_MAX_ITERATIONS ? Number(env.CHAT_AGENT_MAX_ITERATIONS) : 10,
    numCtx: env.CHAT_NUM_CTX ? Number(env.CHAT_NUM_CTX) : 16384,
    skillsMcpUrl: env.SKILLS_MCP_URL || "http://skills-mcp:3001",
    postgres: {
      host: env.POSTGRES_HOST || "postgres",
      port: env.POSTGRES_PORT ? Number(env.POSTGRES_PORT) : 5432,
      n8nDatabase: env.N8N_DB_NAME || "n8n",
      user: env.POSTGRES_USER || "assistant",
      password: postgresPassword,
    },
    dbSchema: env.CHAT_DB_SCHEMA || "public",
    redis: {
      host: env.REDIS_HOST || "redis",
      port: env.REDIS_PORT ? Number(env.REDIS_PORT) : 6379,
      db: env.REDIS_DB ? Number(env.REDIS_DB) : 0,
    },
    honchoApiKey: env.HONCHO_API_KEY || undefined,
    honchoWorkspaceId: env.HONCHO_WORKSPACE_ID || "smart-assistant",
    eventBusUrl: env.EVENT_BUS_URL || "http://event-bus:3004",
    memoryEngineUrl: env.MEMORY_ENGINE_URL || "http://memory-engine:3007",
  };
}
