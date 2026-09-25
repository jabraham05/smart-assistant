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
  // Second, independent gate alongside routeToWebThreshold (see
  // engine/router.ts): the top result must also share at least this many
  // real, non-trivial keywords with the query. Added after live testing
  // proved the RRF score alone can't tell a genuine match from an
  // unrelated same-domain "best of a bad bunch" - a real brake-fluid
  // question and a completely unrelated "Nissan GT-R" question against a
  // Porsche-only corpus both scored ~0.0164, because a domain-filtered
  // vector search always ranks *something* top-K regardless of true
  // relevance. Default of 1 is deliberately low - it only needs to rule
  // out zero genuine overlap, not demand a strong match, since embeddings
  // alone should still carry real paraphrased matches.
  minKeywordOverlap: number;
  // Model for the research agent loop (engine/research-agent.ts) and the
  // contradiction-verification calls (engine/verify.ts) - same model the
  // Chat workflow's AI Agent and skill_gap_scanner's dedup check use.
  researchModel: string;
  researchMaxIterations: number;
  // notify.ts - posting a real follow-up into the chat session a
  // background research run was started from, once it finishes. Same
  // fields/pattern as coding-orchestrator's notify.ts.
  n8nDatabase: string;
  honchoApiKey?: string;
  honchoWorkspaceId: string;
  // Only used by notify.ts's logAwaitingDigest (deferred-notify path for
  // background-classified research) - the overnight digest scanner reads
  // this back later. See event-bus/src/index.ts's /overnight-digest-check.
  eventBusUrl: string;
  // engine/consolidate.ts / lib/coding-orchestrator-client.ts - a
  // coding-activity project's approve step calls coding-orchestrator
  // directly (not through the old n8n webhook shim skills-mcp's code_task
  // tool still uses) - same always-on-infra tier as eventBusUrl above.
  codingOrchestratorUrl: string;
  // engine/research-queue.ts - the self-learning research queue. Reject
  // (not evict) a new enqueue once this many rows are pending/researching -
  // a full queue means the drain rate needs attention, not silent data
  // loss. Default chosen as a generous ceiling unlikely to bind in normal
  // use, not a tuned value yet (no real usage data exists).
  researchQueueMaxPending: number;
  // Lexeme-overlap floor for the queue's own dedup check (topic vs. topic,
  // not topic vs. document content) - higher than knowledge-engine's own
  // minKeywordOverlap (1) because topic strings are short and generic, so
  // a 1-word overlap is far more likely to be a coincidence than it is
  // against a full document chunk.
  researchQueueDedupMinOverlap: number;
  // Max queue items drained per wake event (event-bus's POST
  // /calendar/poll-check) - keeps an overnight run bounded rather than
  // draining an entire backlog in one go.
  researchQueueDrainLimit: number;
  // Phase 3 of the infrastructure rebuild - the decision/project/growth
  // ledger. Always-on internal infra, same tier as eventBusUrl above -
  // POST /projects/:id/approve and consolidateProject both fire
  // fire-and-forget episode writes here.
  graphitiServiceUrl: string;
  // Phase 4 of the infrastructure rebuild - real page-content extraction
  // (JS rendering + anti-bot fallback), used by lib/html-extract.ts's
  // extractUrl. Always-on internal infra, same tier as graphitiServiceUrl -
  // extractUrl falls back to its own plain fetch()+JSDOM+Readability path
  // if this is genuinely unreachable, so this is not a hard dependency.
  scraplingServiceUrl: string;
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
    routeToWebThreshold: env.KNOWLEDGE_ROUTE_TO_WEB_THRESHOLD ? Number(env.KNOWLEDGE_ROUTE_TO_WEB_THRESHOLD) : 0.012,
    minKeywordOverlap: env.KNOWLEDGE_MIN_KEYWORD_OVERLAP ? Number(env.KNOWLEDGE_MIN_KEYWORD_OVERLAP) : 1,
    researchModel: env.KNOWLEDGE_RESEARCH_MODEL || "qwen3:8b",
    researchMaxIterations: env.KNOWLEDGE_RESEARCH_MAX_ITERATIONS ? Number(env.KNOWLEDGE_RESEARCH_MAX_ITERATIONS) : 12,
    n8nDatabase: env.N8N_DB_NAME || "n8n",
    honchoApiKey: env.HONCHO_API_KEY || undefined,
    honchoWorkspaceId: env.HONCHO_WORKSPACE_ID || "smart-assistant",
    eventBusUrl: env.EVENT_BUS_URL || "http://event-bus:3004",
    codingOrchestratorUrl: env.CODING_ORCHESTRATOR_URL || "http://coding-orchestrator:3003",
    researchQueueMaxPending: env.RESEARCH_QUEUE_MAX_PENDING ? Number(env.RESEARCH_QUEUE_MAX_PENDING) : 50,
    researchQueueDedupMinOverlap: env.RESEARCH_QUEUE_DEDUP_MIN_OVERLAP ? Number(env.RESEARCH_QUEUE_DEDUP_MIN_OVERLAP) : 2,
    researchQueueDrainLimit: env.RESEARCH_QUEUE_DRAIN_LIMIT ? Number(env.RESEARCH_QUEUE_DRAIN_LIMIT) : 3,
    graphitiServiceUrl: env.GRAPHITI_SERVICE_URL || "http://graphiti-service:3012",
    scraplingServiceUrl: env.SCRAPLING_SERVICE_URL || "http://scrapling-service:3013",
  };
}
