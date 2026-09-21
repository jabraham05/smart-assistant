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
  // How many chat.message_received events must accumulate since
  // scanner_state's last_run before /skill-gap-check tells
  // skill_gap_scanner it's actually worth running its Honcho+Ollama
  // reasoning, instead of that running on a fixed schedule regardless of
  // whether anything happened.
  skillGapCheckMessages: number;
  // Optional, same "clear degradation, not a crash" pattern as
  // honchoApiKey: notifyOwnerDirect() logs and drops instead of throwing
  // when unset. Used only for the orphaned-high-priority-event escalation
  // path (see index.ts) - not required for any other event-bus behavior.
  discordBotToken?: string;
  discordAllowedUserId?: string;
  // Always-on internal infra, real default rather than optional/undefined -
  // same tier as eventBusUrl elsewhere in this project. Lets calendar-watch.ts
  // reuse skills-mcp's existing Google Calendar auth instead of duplicating
  // the service-account key into this image too.
  skillsMcpUrl: string;
  // How close to an event's start time (minutes) before /calendar/poll-check
  // fires the one-time "starting soon" reminder for it.
  calendarReminderLeadMinutes: number;
  // How far ahead (hours) each poll asks skills-mcp for upcoming events.
  calendarPollLookaheadHours: number;
  // Read-only pools into databases event-bus doesn't otherwise own, same
  // precedent as n8nDatabase above - just the database name differs, same
  // Postgres host/user/password. Used only by work-level.ts to answer
  // "is a coding or research task currently running."
  codingTasksDbName: string;
  researchDbName: string;
  // How many hours of continuous low work-level must pass between
  // idle-reflection reasoning runs (see /idle-reflection-check).
  idleReflectionMinHours: number;
  // Separate, stricter cooldown specifically for the "message the user
  // directly" outcome (see /idle-reflection-check's canMessageUser and
  // /idle-reflection-messaged) - deliberately independent of
  // idleReflectionMinHours so silent skill proposals can still queue up
  // more often than proactive DMs are allowed to fire.
  idleReflectionMessageMinHours: number;
  // Overnight digest (see digest.ts): minimum hours between proactive
  // digest DMs - deliberately independent of any calendar-side cadence,
  // so a mis-detected "wake" event or a poll re-run can never double-send.
  overnightDigestMinHours: number;
  ollamaHost: string;
  digestModel: string;
  tavilyApiKey?: string;
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
    skillGapCheckMessages: env.SKILL_GAP_CHECK_MESSAGES ? Number(env.SKILL_GAP_CHECK_MESSAGES) : 10,
    discordBotToken: env.DISCORD_BOT_TOKEN || undefined,
    discordAllowedUserId: env.DISCORD_ALLOWED_USER_ID || undefined,
    skillsMcpUrl: env.SKILLS_MCP_URL || "http://skills-mcp:3001",
    calendarReminderLeadMinutes: env.CALENDAR_REMINDER_LEAD_MINUTES
      ? Number(env.CALENDAR_REMINDER_LEAD_MINUTES)
      : 30,
    calendarPollLookaheadHours: env.CALENDAR_POLL_LOOKAHEAD_HOURS
      ? Number(env.CALENDAR_POLL_LOOKAHEAD_HOURS)
      : 24,
    codingTasksDbName: env.CODING_TASKS_DB_NAME || "coding_tasks",
    researchDbName: env.RESEARCH_DB_NAME || "research",
    idleReflectionMinHours: env.IDLE_REFLECTION_MIN_HOURS ? Number(env.IDLE_REFLECTION_MIN_HOURS) : 4,
    idleReflectionMessageMinHours: env.IDLE_REFLECTION_MESSAGE_MIN_HOURS
      ? Number(env.IDLE_REFLECTION_MESSAGE_MIN_HOURS)
      : 24,
    overnightDigestMinHours: env.OVERNIGHT_DIGEST_MIN_HOURS ? Number(env.OVERNIGHT_DIGEST_MIN_HOURS) : 20,
    ollamaHost: env.OLLAMA_HOST || "http://ollama:11434",
    digestModel: env.DIGEST_MODEL || "qwen3:8b",
    tavilyApiKey: env.TAVILY_API_KEY || undefined,
  };
}
