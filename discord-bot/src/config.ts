export interface Config {
  discordBotToken: string;
  allowedUserId: string;
  chatWebhookUrl: string;
  // Always-on internal infra, real default rather than optional/undefined -
  // same tier as chatWebhookUrl.
  eventBusUrl: string;
  // The Amy identity (agent-service's config.is_test_user) the allowlisted
  // Discord account maps to - NOT the same thing as allowedUserId (that's
  // just "which Discord account may DM this bot at all"). Defaults to
  // "test" so a freshly deployed/upgraded bot never silently writes into a
  // real profile until this is explicitly set.
  amyUserId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const discordBotToken = env.DISCORD_BOT_TOKEN;
  if (!discordBotToken) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }

  const allowedUserId = env.DISCORD_ALLOWED_USER_ID;
  if (!allowedUserId) {
    throw new Error("DISCORD_ALLOWED_USER_ID is required");
  }

  const chatWebhookUrl = env.N8N_CHAT_WEBHOOK_URL;
  if (!chatWebhookUrl) {
    throw new Error("N8N_CHAT_WEBHOOK_URL is required");
  }

  const eventBusUrl = env.EVENT_BUS_URL || "http://event-bus:3004";
  const amyUserId = env.AMY_USER_ID || "test";

  return { discordBotToken, allowedUserId, chatWebhookUrl, eventBusUrl, amyUserId };
}
