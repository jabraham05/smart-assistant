export interface Config {
  discordBotToken: string;
  allowedUserId: string;
  chatWebhookUrl: string;
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

  return { discordBotToken, allowedUserId, chatWebhookUrl };
}
