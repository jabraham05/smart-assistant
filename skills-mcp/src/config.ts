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
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  spotifyRefreshToken?: string;
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
    // Optional, not required at startup: spotify_control returns a clear
    // config-missing error at call time (see lib/spotify.ts), same
    // pattern as the calendar tools. SPOTIFY_REFRESH_TOKEN is obtained
    // via the one-time scripts/spotify-auth.mjs bootstrap.
    spotifyClientId: env.SPOTIFY_CLIENT_ID || undefined,
    spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET || undefined,
    spotifyRefreshToken: env.SPOTIFY_REFRESH_TOKEN || undefined,
  };
}
