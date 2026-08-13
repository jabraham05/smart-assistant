export interface Config {
  discordBotToken: string;
  allowedUserId: string;
  chatWebhookUrl: string;
  // Always-on internal infra, real default rather than optional/undefined -
  // same tier as chatWebhookUrl.
  eventBusUrl: string;
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

  return { discordBotToken, allowedUserId, chatWebhookUrl, eventBusUrl };
}
