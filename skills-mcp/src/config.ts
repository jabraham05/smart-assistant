export interface Config {
  port: number;
  honchoApiKey: string;
  honchoWorkspaceId: string;
  homeLocation?: string;
  homeLatitude?: number;
  homeLongitude?: number;
  homeTimezone: string;
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  googleCalendarId?: string;
  googleOauthClientId?: string;
  googleOauthClientSecret?: string;
  googleRefreshToken?: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  spotifyRefreshToken?: string;
  dashboardControlWebhookUrl?: string;
  sandboxRunnerUrl: string;
  eventBusUrl: string;
  tavilyApiKey?: string;
  knowledgeEngineUrl: string;
  memoryEngineUrl: string;
  // Always-on internal infra, same tier as eventBusUrl/knowledgeEngineUrl
  // above - growth_review (Phase 6.5) proxies to agent-service's own
  // /growth/* HTTP routes, since the Growth engine's data access lives
  // there rather than in its own microservice (see docs/growth-engine.md).
  agentServiceUrl: string;
  // Used directly by code_task/code_task_status (lib/coding-workflow.ts)
  // for task submission/status, and by lib/coding-orchestrator-client.ts's
  // read-only listCodingTasks - the old CODING_TASK_WEBHOOK_URL/
  // CODING_TASK_STATUS_WEBHOOK_URL n8n shim these used to submit through
  // is retired as of the same fix that found it: a transient n8n database
  // outage was silently swallowing every coding task submitted via Discord,
  // with no coding_tasks row ever created and no reply reaching the user.
  codingOrchestratorUrl: string;
  // Unlike every other *Url field above, this must be reachable from the
  // user's own browser, not just from inside the Docker network - it's
  // used to build a real clickable link (research_task_status's
  // documentUrl) that Amy includes in a chat reply, not a server-to-server
  // call. Defaults to localhost since this is a single-machine personal
  // setup; override if chat-ui is reachable at a LAN IP or domain instead.
  chatUiUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const honchoApiKey = env.HONCHO_API_KEY;
  if (!honchoApiKey) {
    throw new Error("HONCHO_API_KEY is required");
  }

  const postgresPassword = env.POSTGRES_PASSWORD;
  if (!postgresPassword) {
    throw new Error("POSTGRES_PASSWORD is required");
  }

  const homeLatitude = env.HOME_LATITUDE ? Number(env.HOME_LATITUDE) : undefined;
  const homeLongitude = env.HOME_LONGITUDE ? Number(env.HOME_LONGITUDE) : undefined;

  return {
    port: env.PORT ? Number(env.PORT) : 3001,
    honchoApiKey,
    honchoWorkspaceId: env.HONCHO_WORKSPACE_ID ?? "smart-assistant",
    homeLocation: env.HOME_LOCATION || undefined,
    homeLatitude: Number.isFinite(homeLatitude) ? homeLatitude : undefined,
    homeLongitude: Number.isFinite(homeLongitude) ? homeLongitude : undefined,
    // calendar_event's reference for converting a bare local time into the
    // correct offset instead of defaulting to UTC - always has a value
    // (unlike the weather home-location fields above), since calendar_event
    // needs a concrete offset to put in its tool description regardless of
    // whether the user ever configured one.
    homeTimezone: env.HOME_TIMEZONE || "America/Los_Angeles",
    postgres: {
      host: env.POSTGRES_HOST || "postgres",
      port: env.POSTGRES_PORT ? Number(env.POSTGRES_PORT) : 5432,
      // Dedicated database (see postgres/init/21-create-skills-db.sql) - the
      // first Postgres connection skills-mcp has ever owned, replacing the
      // old skill_proposal_intake n8n webhook + Data Table.
      database: env.SKILLS_DB_NAME || "skills",
      user: env.POSTGRES_USER || "assistant",
      password: postgresPassword,
    },
    // Optional, not required at startup: calendar/drive tools return a
    // clear config-missing error at call time (see lib/google-oauth.ts)
    // rather than crashing the whole server for users who haven't set
    // this up yet, matching how HOME_LOCATION/HOME_LATITUDE/HOME_LONGITUDE
    // work. GOOGLE_REFRESH_TOKEN comes from the one-time
    // scripts/google-auth.mjs bootstrap, same pattern as
    // SPOTIFY_REFRESH_TOKEN below - replaces a now-dead service-account
    // key (its backing Google Cloud project was deleted) that also
    // couldn't have covered Drive access in the first place.
    googleCalendarId: env.GOOGLE_CALENDAR_ID || undefined,
    googleOauthClientId: env.GOOGLE_OAUTH_CLIENT_ID || undefined,
    googleOauthClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || undefined,
    googleRefreshToken: env.GOOGLE_REFRESH_TOKEN || undefined,
    // Optional, not required at startup: spotify_control returns a clear
    // config-missing error at call time (see lib/spotify.ts), same
    // pattern as the calendar tools. SPOTIFY_REFRESH_TOKEN is obtained
    // via the one-time scripts/spotify-auth.mjs bootstrap.
    spotifyClientId: env.SPOTIFY_CLIENT_ID || undefined,
    spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET || undefined,
    spotifyRefreshToken: env.SPOTIFY_REFRESH_TOKEN || undefined,
    // Optional, not required at startup: dashboard_control returns a clear
    // config-missing error at call time, same pattern as the calendar/
    // Spotify tools use.
    dashboardControlWebhookUrl: env.DASHBOARD_CONTROL_WEBHOOK_URL || undefined,
    // Always-on internal infra (like ollama/postgres), not a per-user
    // optional integration — no config-missing error path needed, unlike
    // the calendar/Spotify/dashboard webhooks above.
    sandboxRunnerUrl: env.SANDBOX_RUNNER_URL || "http://sandbox-runner:3002",
    // Always-on internal infra, same tier as sandboxRunnerUrl above -
    // goal_manage has no config-missing error path, it just uses this.
    eventBusUrl: env.EVENT_BUS_URL || "http://event-bus:3004",
    // Optional, not required at startup: web_search returns a clear
    // config-missing error at call time, same pattern as the calendar/
    // Spotify/dashboard tools use. Get a free key at tavily.com.
    tavilyApiKey: env.TAVILY_API_KEY || undefined,
    // Always-on internal infra, same tier as sandboxRunnerUrl/eventBusUrl
    // above - knowledge_search/knowledge_ingest/research_task/
    // research_task_status all talk to this directly, no n8n hop and no
    // config-missing error path. Replaces the old RESEARCH_*_WEBHOOK_URL
    // vars that pointed at research_pipeline's n8n webhooks.
    knowledgeEngineUrl: env.KNOWLEDGE_ENGINE_URL || "http://knowledge-engine:3005",
    codingOrchestratorUrl: env.CODING_ORCHESTRATOR_URL || "http://coding-orchestrator:3003",
    memoryEngineUrl: env.MEMORY_ENGINE_URL || "http://memory-engine:3007",
    agentServiceUrl: env.AGENT_SERVICE_URL || "http://agent-service:3010",
    chatUiUrl: env.CHAT_UI_URL || "http://localhost:3000",
  };
}
