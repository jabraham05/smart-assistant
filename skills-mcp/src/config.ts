export interface Config {
  port: number;
  honchoApiKey: string;
  honchoWorkspaceId: string;
  homeLocation?: string;
  homeLatitude?: number;
  homeLongitude?: number;
  homeTimezone: string;
  skillsProposalWebhookUrl: string;
  googleCalendarKeyFile?: string;
  googleCalendarId?: string;
  codingTaskWebhookUrl?: string;
  codingTaskStatusWebhookUrl?: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  spotifyRefreshToken?: string;
  dashboardControlWebhookUrl?: string;
  sandboxRunnerUrl: string;
  eventBusUrl: string;
  tavilyApiKey?: string;
  knowledgeEngineUrl: string;
  memoryEngineUrl: string;
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

  const skillsProposalWebhookUrl = env.SKILLS_PROPOSAL_WEBHOOK_URL;
  if (!skillsProposalWebhookUrl) {
    throw new Error("SKILLS_PROPOSAL_WEBHOOK_URL is required");
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
    skillsProposalWebhookUrl,
    // Optional, not required at startup: calendar tools return a clear
    // config-missing error at call time (see lib/google-calendar.ts)
    // rather than crashing the whole server for users who haven't set this
    // up yet, matching how HOME_LOCATION/HOME_LATITUDE/HOME_LONGITUDE work.
    googleCalendarKeyFile: env.GOOGLE_CALENDAR_KEY_FILE || undefined,
    googleCalendarId: env.GOOGLE_CALENDAR_ID || undefined,
    // Optional, not required at startup: code_task returns a clear
    // config-missing error at call time rather than crashing the whole
    // server, same pattern as the calendar tools use.
    codingTaskWebhookUrl: env.CODING_TASK_WEBHOOK_URL || undefined,
    // Optional, not required at startup, same pattern: code_task_status
    // returns a clear config-missing error at call time rather than
    // crashing the whole server.
    codingTaskStatusWebhookUrl: env.CODING_TASK_STATUS_WEBHOOK_URL || undefined,
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
    memoryEngineUrl: env.MEMORY_ENGINE_URL || "http://memory-engine:3007",
    chatUiUrl: env.CHAT_UI_URL || "http://localhost:3000",
  };
}
