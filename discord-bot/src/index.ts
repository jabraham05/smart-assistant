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

// One stable session per Discord user by default, so conversation memory
// persists across app restarts and separate phone sessions the same way the
// CLI client's .chat-session-id file does. `!new` overrides that in memory
// with a fresh, timestamped sessionId so old history stops being loaded —
// this override doesn't survive a container restart, which just falls back
// to the original stable session.
const sessionOverrides = new Map<string, string>();
const NEW_SESSION_COMMANDS = new Set(["!new", "/new"]);

function currentSessionId(userId: string): string {
  return sessionOverrides.get(userId) ?? `discord-${userId}`;
}

// Fire-and-forget - never blocks or delays the actual reply, and a down/
// unreachable event-bus must never affect the real DM flow.
function publishDmReceivedEvent(preview: string): void {
  fetch(`${config.eventBusUrl}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "discord", type: "dm_received", payload: { preview } }),
  }).catch((e) => console.error("failed to publish dm_received event:", e));
}

client.once(Events.ClientReady, (c) => {
  console.log(`discord-bot logged in as ${c.user.tag}, forwarding DMs from user ${config.allowedUserId}`);
});

// Real, live-observed failure (2026-10-10): the container never crashed and
// docker compose ps showed it healthy for 16+ hours, but Discord showed the
// bot offline the whole time - discord.js can give up on reconnecting after
// a dropped gateway session without throwing anything that crashes the
// process, so there was nothing here to catch it and nothing for the
// `restart: unless-stopped` policy to act on. Invalidated specifically
// means discord.js has exhausted its own reconnect attempts and the
// session is dead for good; Error/ShardError are a catch-all for anything
// else that could silently wedge the connection. Exiting lets Docker's
// existing restart policy do exactly what manually restarting the
// container was doing - there's no in-process recovery that's more
// reliable than a clean fresh client.login().
client.on(Events.Error, (err) => {
  console.error("discord client error, exiting for restart:", err);
  process.exit(1);
});
client.on(Events.ShardError, (err) => {
  console.error("discord shard error, exiting for restart:", err);
  process.exit(1);
});
client.on(Events.Invalidated, () => {
  console.error("discord session invalidated (reconnect exhausted), exiting for restart");
  process.exit(1);
});

// Second real finding, same day: after the fix above, the container ran
// for hours with 0 restarts (confirmed via `docker inspect` RestartCount)
// and Discord still showed the bot offline - none of Error/ShardError/
// Invalidated ever fired. That means the gateway connection went fully
// silent without discord.js itself ever noticing anything wrong - the
// classic shape of a NAT/idle-timeout killing a long-lived WebSocket
// without a proper close frame on either side (plausible here: Docker
// Desktop's network stack on Windows), which looks like nothing happened
// at the socket level until the next write attempt, if one ever comes.
// Rather than depend on discord.js detecting this, Events.Raw fires for
// every single gateway payload including heartbeat acks (no extra
// intents needed, unlike guild/message content events) - so tracking the
// time since the last one and self-exiting if it goes quiet for far
// longer than the ~41s heartbeat interval catches this regardless of
// whether the library's own reconnect logic ever kicks in.
let lastGatewayActivity = Date.now();
client.on(Events.Raw, () => {
  lastGatewayActivity = Date.now();
});
client.on(Events.ShardDisconnect, (_event, shardId) => {
  console.warn(`discord shard ${shardId} disconnected`);
});
client.on(Events.ShardReconnecting, (shardId) => {
  console.warn(`discord shard ${shardId} reconnecting`);
});
client.on(Events.ShardResume, (shardId) => {
  console.warn(`discord shard ${shardId} resumed`);
  lastGatewayActivity = Date.now();
});

const GATEWAY_WATCHDOG_INTERVAL_MS = 30_000;
const GATEWAY_SILENCE_LIMIT_MS = 120_000;
setInterval(() => {
  const silentFor = Date.now() - lastGatewayActivity;
  if (silentFor > GATEWAY_SILENCE_LIMIT_MS) {
    console.error(`no gateway activity for ${Math.round(silentFor / 1000)}s, exiting for restart`);
    process.exit(1);
  }
}, GATEWAY_WATCHDOG_INTERVAL_MS);

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== ChannelType.DM) return;
  if (message.author.id !== config.allowedUserId) {
    console.warn(`Ignoring DM from non-allowlisted user ${message.author.id}`);
    return;
  }
  const trimmed = message.content.trim();
  if (!trimmed) return;

  publishDmReceivedEvent(trimmed.slice(0, 200));

  if (NEW_SESSION_COMMANDS.has(trimmed.toLowerCase())) {
    sessionOverrides.set(message.author.id, `discord-${message.author.id}-${Date.now()}`);
    await message.channel.send("Started a new session — previous conversation won't carry over.").catch(() => {});
    return;
  }

  const typingTimer = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, TYPING_REFRESH_MS);
  message.channel.sendTyping().catch(() => {});

  try {
    const sessionId = currentSessionId(message.author.id);
    // The ack (if any) is sent as its own message the moment it arrives,
    // well before the rest of the turn finishes - the typing indicator
    // above keeps running throughout, unaffected.
    const reply = await sendChatMessage(config.chatWebhookUrl, message.content, sessionId, (ackText) => {
      message.channel.send(ackText).catch(() => {});
    });
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
