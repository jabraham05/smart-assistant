export interface Config {
  port: number;
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  // Where embedding/chat calls go - same host every other service in this
  // project reaches Ollama at.
  ollamaHost: string;
  embeddingModel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const postgresPassword = env.POSTGRES_PASSWORD;
  if (!postgresPassword) {
    throw new Error("POSTGRES_PASSWORD is required");
  }

  return {
    port: env.PORT ? Number(env.PORT) : 3005,
    postgres: {
      host: env.POSTGRES_HOST || "postgres",
      port: env.POSTGRES_PORT ? Number(env.POSTGRES_PORT) : 5432,
      // Reuses the existing `research` database (pgvector already
      // installed there) rather than provisioning a new one - no
      // functional reason to pay the "apply manually to the existing
      // volume" ceremony twice for what is conceptually the same storage
      // tier. The database's name staying `research` while the tables
      // inside it are new (documents/chunks/...) is a harmless naming
      // leftover, same tier as event-bus itself being named after its
      // narrower original scope.
      database: env.RESEARCH_DB_NAME || "research",
      user: env.POSTGRES_USER || "assistant",
      password: postgresPassword,
    },
    ollamaHost: env.OLLAMA_HOST || "http://ollama:11434",
    embeddingModel: env.KNOWLEDGE_EMBEDDING_MODEL || "nomic-embed-text",
  };
}
