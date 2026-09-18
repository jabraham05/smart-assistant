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
  // Optional, same "clear degradation" pattern as everywhere else Tavily is
  // used (skills-mcp's web_search) - web escalation just returns a clear
  // error if a research() call actually needs it and this is unset, rather
  // than the whole service failing to start.
  tavilyApiKey?: string;
  // The router's deterministic threshold (see engine/router.ts): a
  // knowledge-base hit with an RRF score below this is treated as "not
  // good enough," escalating to live web search instead. Chosen from real
  // observed scores during Phase 1c testing (a genuinely relevant top
  // result scored ~0.03; a weak/tangential one ~0.015) - deliberately a
  // config value, not a hardcoded constant, since the right cutoff is an
  // empirical question likely to need retuning once real usage exists.
  routeToWebThreshold: number;
  // Model for the research agent loop (engine/research-agent.ts) and the
  // contradiction-verification calls (engine/verify.ts) - same model the
  // Chat workflow's AI Agent and skill_gap_scanner's dedup check use.
  researchModel: string;
  researchMaxIterations: number;
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
    tavilyApiKey: env.TAVILY_API_KEY || undefined,
    routeToWebThreshold: env.KNOWLEDGE_ROUTE_TO_WEB_THRESHOLD ? Number(env.KNOWLEDGE_ROUTE_TO_WEB_THRESHOLD) : 0.02,
    researchModel: env.KNOWLEDGE_RESEARCH_MODEL || "qwen3:8b",
    researchMaxIterations: env.KNOWLEDGE_RESEARCH_MAX_ITERATIONS ? Number(env.KNOWLEDGE_RESEARCH_MAX_ITERATIONS) : 12,
  };
}
