export interface Config {
  port: number;
  honchoApiKey: string;
  honchoWorkspaceId: string;
  homeLocation?: string;
  homeLatitude?: number;
  homeLongitude?: number;
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
  tavilyApiKey?: string;
  researchTaskWebhookUrl?: string;
  researchTaskStatusWebhookUrl?: string;
  researchSearchWebhookUrl?: string;
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
    // Optional, not required at startup: web_search returns a clear
    // config-missing error at call time, same pattern as the calendar/
    // Spotify/dashboard tools use. Get a free key at tavily.com.
    tavilyApiKey: env.TAVILY_API_KEY || undefined,
    // Optional, not required at startup: research_task/research_task_status/
    // research_search each return a clear config-missing error at call time,
    // same pattern as the coding-task webhooks. See README's Research
    // workflow section for the one-time research DB + pgvector setup these
    // depend on.
    researchTaskWebhookUrl: env.RESEARCH_TASK_WEBHOOK_URL || undefined,
    researchTaskStatusWebhookUrl: env.RESEARCH_TASK_STATUS_WEBHOOK_URL || undefined,
    researchSearchWebhookUrl: env.RESEARCH_SEARCH_WEBHOOK_URL || undefined,
  };
}
