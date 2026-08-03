import { Client, GatewayIntentBits, Partials, ChannelType, Events } from "discord.js";
import { loadConfig } from "./config.js";
import { sendChatMessage, chunkForDiscord } from "./chat-client.js";

const config = loadConfig(process.env);

// DirectMessages + MessageContent (privileged, must be enabled in the
// Discord Developer Portal's Bot settings) are the only intents needed —
// this bot only ever talks to one allowlisted user over DM, never reads
// guild channels. Partials.Channel is required for DM messageCreate events
// to fire reliably (DM channels aren't always cached).
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

// discord.js typing indicators last ~10s server-side; refresh every 8s so
// it stays visible for the whole time a reply is being generated.
const TYPING_REFRESH_MS = 8000;

client.once(Events.ClientReady, (c) => {
  console.log(`discord-bot logged in as ${c.user.tag}, forwarding DMs from user ${config.allowedUserId}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== ChannelType.DM) return;
  if (message.author.id !== config.allowedUserId) {
    console.warn(`Ignoring DM from non-allowlisted user ${message.author.id}`);
    return;
  }
  if (!message.content.trim()) return;

  const typingTimer = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, TYPING_REFRESH_MS);
  message.channel.sendTyping().catch(() => {});

  try {
    // One stable session per Discord user, so conversation memory persists
    // across app restarts and separate phone sessions the same way the CLI
    // client's .chat-session-id file does.
    const sessionId = `discord-${message.author.id}`;
    const reply = await sendChatMessage(config.chatWebhookUrl, message.content, sessionId);
    const text = reply.trim() || "(no response)";
    for (const chunk of chunkForDiscord(text)) {
      await message.channel.send(chunk);
    }
  } catch (err) {
    console.error("Failed to get a reply from the Chat webhook:", err);
    await message.channel.send("Something went wrong reaching Amy just now — try again in a bit.").catch(() => {});
  } finally {
    clearInterval(typingTimer);
  }
});

client.login(config.discordBotToken);
