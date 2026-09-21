import express from "express";
import { loadConfig } from "./config.js";
import * as db from "./db.js";
import * as honcho from "./honcho.js";
import * as sessionMemory from "./session-memory.js";
import { publishMessageEvent, publishClassificationEvent } from "./events.js";
import { classifyRelevantTools } from "./classify-tools.js";
import { formatSkillsCatalog } from "./skills-catalog.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { SkillsMcpClient } from "./mcp-client.js";
import { runAgentLoop, type AgentTool } from "./agent-loop.js";
import { hasUnfulfilledSearchIntent, isConfabulatedAction, SEARCH_RETRY_NUDGE } from "./safety-net.js";

const config = loadConfig(process.env);

const FALLBACK_PERSONA =
  "You are Amy, a helpful personal assistant. (The real persona row could not be loaded - this is a " +
  "minimal fallback, not the user's configured character/tone.)";

const app = express();
app.use(express.json({ limit: "2mb" }));

// NDJSON event shape matches the old n8n Chat workflow's streaming
// response exactly (one JSON object per line, {type, content, metadata:
// {nodeId, nodeName, itemIndex, runIndex, timestamp}}) - both chat-ui and
// discord-bot only ever treat type:"item" with metadata.nodeName:"AI Agent"
// as reply text, so preserving that literal string is what lets both
// clients keep working with zero code changes once this service is
// pointed at.
const NODE_NAME = "AI Agent";

function makeEmitter(res: express.Response) {
  let itemIndex = 0;
  return (type: "begin" | "item" | "end" | "error", content?: string) => {
    const event = {
      type,
      ...(content !== undefined ? { content } : {}),
      metadata: { nodeId: "chat-orchestrator", nodeName: NODE_NAME, itemIndex: itemIndex++, runIndex: 0, timestamp: Date.now() },
    };
    res.write(JSON.stringify(event) + "\n");
  };
}

app.post("/webhook", async (req, res) => {
  const body = req.body as { chatInput?: string; sessionId?: string };
  if (!body.chatInput || typeof body.chatInput !== "string" || !body.sessionId || typeof body.sessionId !== "string") {
    return res.status(400).json({ error: "chatInput and sessionId are required" });
  }
  const { chatInput, sessionId } = body;

  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  const emit = makeEmitter(res);

  publishMessageEvent(config, sessionId, chatInput).catch((e) => console.error("publishMessageEvent failed:", e));

  try {
    const classifyStartedAt = Date.now();
    const [classification, personaSystemPrompt, activeSkills, history] = await Promise.all([
      classifyRelevantTools(config.ollamaHost, config.classifierModel, chatInput),
      db.getPersonaSystemPrompt(config).catch((e) => {
        console.error("getPersonaSystemPrompt failed:", e);
        return undefined;
      }),
      db.getActiveInstructionSkills(config).catch((e) => {
        console.error("getActiveInstructionSkills failed:", e);
        return [];
      }),
      sessionMemory.getRecentHistory(config, sessionId).catch((e) => {
        console.error("getRecentHistory failed:", e);
        return [];
      }),
    ]);
    const { relevantGroups, relevantTools, toolPolicy, memoryPolicy, needsPlanning, background } = classification;

    console.log(
      `chat classify [${sessionId}]: groups=${relevantGroups.join(",") || "(none)"} ` +
        `tools=${relevantTools.join(",")} toolPolicy=${toolPolicy} memoryPolicy=${memoryPolicy} ` +
        `needsPlanning=${needsPlanning} background=${background} (${Date.now() - classifyStartedAt}ms)`,
    );
    publishClassificationEvent(config, sessionId, {
      relevantGroups,
      relevantTools,
      toolPolicy,
      memoryPolicy,
      needsPlanning,
      background,
      classifyMs: Date.now() - classifyStartedAt,
    }).catch((e) => console.error("publishClassificationEvent failed:", e));

    await honcho.ensureSessionExists(config, sessionId);
    await honcho.setUserObserveConfig(config, sessionId);
    const [userCard, userCardForAmy] = await Promise.all([
      honcho.getUserCard(config),
      honcho.getUserCardForAmy(config),
    ]);

    const systemPrompt = buildSystemPrompt({
      personaSystemPrompt: personaSystemPrompt ?? FALLBACK_PERSONA,
      now: new Date(),
      userCard,
      userCardForAmy,
      skillsCatalogText: formatSkillsCatalog(activeSkills),
    });

    const mcp = new SkillsMcpClient(config.skillsMcpUrl, sessionId, background);
    const mcpTools = await mcp.listTools();
    const tools: AgentTool[] = mcpTools
      .filter((t) => relevantTools.includes(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        execute: (args) => mcp.callTool(t.name, args),
      }));

    emit("begin");

    const calledTools: string[] = [];
    const runTurn = (userPrompt: string) =>
      runAgentLoop({
        ollamaHost: config.ollamaHost,
        model: config.chatModel,
        systemPrompt,
        userPrompt,
        history,
        tools,
        maxIterations: config.agentMaxIterations,
        numCtx: config.numCtx,
        label: sessionId,
        onToolCalls: (names) => calledTools.push(...names),
      });

    let result = await runTurn(chatInput);

    // One-shot empty-output retry - same shape as coding-orchestrator's
    // own runCoderRound retry, applied here since a raw tool-calling loop
    // can still occasionally return nothing on a given attempt.
    if (!result.output.trim()) {
      result = await runTurn(chatInput);
    }

    let finalText = result.output.trim()
      ? result.output
      : "No response was generated for that message — try asking again.";

    const boundToolNames = tools.map((t) => t.name);

    // One-shot unfulfilled-search-intent retry.
    if (hasUnfulfilledSearchIntent(finalText, boundToolNames, calledTools)) {
      const retry = await runTurn(chatInput + SEARCH_RETRY_NUDGE);
      if (retry.output.trim()) finalText = retry.output;
    }

    // One-shot confabulated-action retry - explicitly tell the model it
    // claimed a completed action without calling the tool that would
    // actually do it, and to either really call it or stop claiming it did.
    if (isConfabulatedAction(finalText, boundToolNames, calledTools)) {
      const retry = await runTurn(
        chatInput +
          " (Your last reply claimed to have done something, but no matching tool was actually called - " +
          "either actually call the right tool now, or answer without claiming you did.)",
      );
      if (retry.output.trim()) finalText = retry.output;
    }

    emit("item", finalText);
    emit("end");
    res.end();

    await Promise.all([
      honcho.storeTurn(config, sessionId, chatInput, finalText),
      sessionMemory.appendTurn(config, sessionId, chatInput, finalText),
    ]);
  } catch (e) {
    console.error(`chat turn failed for session ${sessionId}:`, e);
    emit("error", e instanceof Error ? e.message : String(e));
    res.end();
  }
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`chat-orchestrator listening on :${config.port} (schema=${config.dbSchema}, redisDb=${config.redis.db})`);
});
