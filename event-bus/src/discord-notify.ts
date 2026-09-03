import type { Config } from "./config.js";

// This machine's Docker networking has been observed (during this feature's
// own verification) to intermittently fail outbound DNS resolution for
// discord.com/gateway.discord.gg with EAI_AGAIN/ENOTFOUND - the same
// failure independently crash-looped discord-bot's gateway connection in
// the same window. A single fetch attempt is too fragile against that for
// what's meant to be a last-resort "nobody else will tell the user" path,
// so transient network failures (not real Discord-side error responses)
// get a few quick retries before giving up.
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
      }
    }
  }
  throw lastError;
}

// Deliberately duplicated rather than routed through discord-bot - same
// convention notify.ts already uses for cross-service duplication. This is
// the one escalation path with no existing notification channel to
// collide with (orphaned high-priority events, see index.ts), so it talks
// to Discord's REST API directly with the bot token rather than adding a
// new inbound endpoint to discord-bot for a single caller.
export async function notifyOwnerDirect(config: Config, message: string): Promise<void> {
  if (!config.discordBotToken || !config.discordAllowedUserId) {
    console.error("notifyOwnerDirect: DISCORD_BOT_TOKEN/DISCORD_ALLOWED_USER_ID not configured, dropping message:", message);
    return;
  }

  try {
    const channelRes = await fetchWithRetry("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: {
        Authorization: `Bot ${config.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: config.discordAllowedUserId }),
    });
    if (!channelRes.ok) {
      console.error(`notifyOwnerDirect: failed to open DM channel: ${channelRes.status}`);
      return;
    }
    const channel = (await channelRes.json()) as { id: string };

    const messageRes = await fetchWithRetry(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${config.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: message }),
    });
    if (!messageRes.ok) {
      console.error(`notifyOwnerDirect: failed to send DM: ${messageRes.status}`);
    }
  } catch (e) {
    console.error("notifyOwnerDirect: failed to send Discord DM after retries:", e);
  }
}
