import { Redis } from "ioredis";
import type { Config } from "./config.js";
import type { OllamaMessage } from "./ollama.js";

// Replaces n8n's Postgres Chat Memory node (contextWindowLength: 15) for
// chat specifically - neither chat-ui nor discord-bot ever read that table
// directly (confirmed: it was purely internal to the old AI Agent's own
// prompt construction), so retiring it for chat has no client-visible
// effect. REDIS_DB (0 prod / 1 test, see config.ts) keeps the two running
// instances' session buffers from ever colliding.

const MAX_TURNS = 15;
// Matches n8n's Postgres Chat Memory table having no TTL of its own in
// practice (sessions are long-lived) while still keeping this bounded -
// 30 days of silence on a session is long past any real "resume this
// conversation" window.
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

interface StoredTurn {
  user: string;
  amy: string;
}

let client: Redis | undefined;

function getClient(config: Config): Redis {
  if (!client) {
    client = new Redis({ host: config.redis.host, port: config.redis.port, db: config.redis.db });
  }
  return client;
}

function key(sessionId: string): string {
  return `chat-orchestrator:session:${sessionId}`;
}

export async function appendTurn(config: Config, sessionId: string, userMessage: string, amyMessage: string): Promise<void> {
  const redis = getClient(config);
  const turn: StoredTurn = { user: userMessage, amy: amyMessage };
  await redis.rpush(key(sessionId), JSON.stringify(turn));
  await redis.ltrim(key(sessionId), -MAX_TURNS, -1);
  await redis.expire(key(sessionId), SESSION_TTL_SECONDS);
}

export async function getRecentHistory(config: Config, sessionId: string): Promise<OllamaMessage[]> {
  const redis = getClient(config);
  const raw = await redis.lrange(key(sessionId), 0, -1);
  const turns = raw
    .map((r) => {
      try {
        return JSON.parse(r) as StoredTurn;
      } catch {
        return undefined;
      }
    })
    .filter((t): t is StoredTurn => !!t);

  const messages: OllamaMessage[] = [];
  for (const t of turns) {
    messages.push({ role: "user", content: t.user });
    messages.push({ role: "assistant", content: t.amy });
  }
  return messages;
}
