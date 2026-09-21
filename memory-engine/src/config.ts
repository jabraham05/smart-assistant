export interface Config {
  port: number;
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  ollamaHost: string;
  embeddingModel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const postgresPassword = env.POSTGRES_PASSWORD;
  if (!postgresPassword) {
    throw new Error("POSTGRES_PASSWORD is required");
  }

  return {
    port: env.PORT ? Number(env.PORT) : 3007,
    postgres: {
      host: env.POSTGRES_HOST || "postgres",
      port: env.POSTGRES_PORT ? Number(env.POSTGRES_PORT) : 5432,
      database: env.MEMORY_DB_NAME || "memory",
      user: env.POSTGRES_USER || "assistant",
      password: postgresPassword,
    },
    ollamaHost: env.OLLAMA_HOST || "http://ollama:11434",
    embeddingModel: env.MEMORY_EMBEDDING_MODEL || "nomic-embed-text",
  };
}
