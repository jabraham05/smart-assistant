import express from "express";
import { loadConfig } from "./config.js";
import * as db from "./db.js";
import * as honcho from "./honcho.js";
import * as sessionMemory from "./session-memory.js";
import { publishMessageEvent, publishClassificationEvent, publishBehaviorFeedbackEvent } from "./events.js";
import { classifyRelevantTools } from "./classify-tools.js";
import { formatSkillsCatalog } from "./skills-catalog.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { SkillsMcpClient } from "./mcp-client.js";
import { searchMemory, ingestMemory } from "./memory-engine-client.js";
import { enqueueResearchTopic } from "./knowledge-engine-client.js";
import { getOpenTaskContexts, matchGoals } from "./event-bus-client.js";
import { runAgentLoop, type AgentTool, type AgentTraceEvent } from "./agent-loop.js";
import {
  hasUnfulfilledSearchIntent,
  isConfabulatedAction,
  hasUnsatisfiedRequiredTool,
  SEARCH_RETRY_NUDGE,
  REQUIRED_TOOL_RETRY_NUDGE,
  REQUIRED_TOOL_FAILURE_MESSAGE,
} from "./safety-net.js";

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

// Readable, client-facing trace of what happened this turn - additive to the
// begin/item/end/error contract above (both real clients only ever look for
// type:"item", so a new type:"trace" line is silently ignored by discord-bot
// and safely opt-in for chat-ui). "classify" fires once, before the agent
// loop starts; "tool_call"/"tool_result"/"retry" fire per attempt (a turn
// can run more than once - see the retry block below), tagged with which
// attempt they belong to so the client can group them.
export type ChatTraceEvent =
  | {
      kind: "classify";
      boundTools: string[];
      relevantGroups: string[];
      toolPolicy: string;
      memoryPolicy: string;
      needsPlanning: boolean;
      background: boolean;
      openTasks: { id: number; objective: string; status: string }[];
      relevantGoals: { id: number; title: string; status: string }[];
      memories: { content: string; domain: string | null; score: number }[];
    }
  | ({ attempt: number } & AgentTraceEvent)
  | { kind: "retry"; attempt: number; reason: "empty_output" | "search_intent" | "confabulation" | "required_tool" };

function makeEmitter(res: express.Response) {
  let itemIndex = 0;
  return (type: "begin" | "item" | "end" | "error" | "trace", content?: string, trace?: ChatTraceEvent) => {
    const event = {
      type,
      ...(content !== undefined ? { content } : {}),
      ...(trace !== undefined ? { trace } : {}),
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
    // fullHistory is awaited before classification fires (not fully
    // parallel with it, unlike the other fetches below) specifically so
    // the classifier can see the single most recent exchange - a real bug
    // found via live testing: a context-free classifier saw "fix that" /
    // "delete it" in isolation and couldn't tell it was a follow-up to a
    // just-created calendar event or task, so the wrong tool group (and
    // therefore the wrong bound tools) got classified. Redis is fast
    // enough that this adds negligible latency ahead of the ~1-2s
    // classification call itself.
    const fullHistory = await sessionMemory.getRecentHistory(config, sessionId).catch((e) => {
      console.error("getRecentHistory failed:", e);
      return [];
    });
    const lastExchange = fullHistory.slice(-2);
    const recentContext = lastExchange.length
      ? lastExchange.map((m) => `${m.role}: ${m.content}`).join("\n")
      : undefined;

    const [classification, personaSystemPrompt, activeSkills, memoryResults, openTasks, relevantGoals] = await Promise.all([
      classifyRelevantTools(config.ollamaHost, config.classifierModel, chatInput, recentContext),
      db.getPersonaSystemPrompt(config).catch((e) => {
        console.error("getPersonaSystemPrompt failed:", e);
        return undefined;
      }),
      db.getActiveInstructionSkills(config).catch((e) => {
        console.error("getActiveInstructionSkills failed:", e);
        return [];
      }),
      // Fetched unconditionally in parallel, same as everything else here -
      // whether memoryPolicy actually allows using the result is decided
      // below, once classification resolves. Gating the fetch itself would
      // mean waiting on classification first, adding its latency as a
      // floor before this could even start - not worth it to skip a rare,
      // cheap call on a memoryPolicy=none turn.
      searchMemory(config, chatInput).catch((e) => {
        console.error("searchMemory failed:", e);
        return [];
      }),
      // Always-on regardless of memoryPolicy - directly actionable state,
      // not ambient personalization (see the architecture plan's
      // context-assembly pipeline). Fetched here, in parallel with
      // everything else, same reasoning as searchMemory above.
      getOpenTaskContexts(config),
      matchGoals(config, chatInput),
    ]);
    const { relevantGroups, relevantTools, toolPolicy, memoryPolicy, needsPlanning, background, knowledgeGapTopic, behaviorFeedback } =
      classification;

    // memoryPolicy only ever gates retrieval/injection into this turn's
    // prompt - never storage. History keeps accumulating in Redis
    // regardless (session-memory.appendTurn below is unconditional); this
    // just decides how much of it actually gets read into context here.
    const history = memoryPolicy === "none" ? fullHistory.slice(-6) : fullHistory;
    const relevantMemories = memoryPolicy === "none" ? [] : memoryResults.map((m) => m.content);

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

    // Self-learning research queue - fire-and-forget, never blocks the
    // reply (enqueueResearchTopic catches its own errors internally, same
    // pattern as ingestMemory below). Dedup/already-known/queue-depth
    // gating all happen inside knowledge-engine's own enqueueTopic.
    if (knowledgeGapTopic) {
      enqueueResearchTopic(config, knowledgeGapTopic, { sessionId });
    }

    // Feedback-capture - fire-and-forget, same reasoning as the enqueue
    // above. Just logs the raw signal; nothing reads it automatically yet
    // (see docs/chat-orchestrator.md's dated entry).
    if (behaviorFeedback) {
      publishBehaviorFeedbackEvent(config, sessionId, behaviorFeedback).catch((e) =>
        console.error("publishBehaviorFeedbackEvent failed:", e),
      );
    }

    // Skip the peer-card fetch entirely (not just its injection) for
    // memoryPolicy=none - these calls already run sequentially after
    // classification, not in the initial parallel batch, so there's a
    // real latency win here and no downside (unlike searchMemory above).
    let userCard: string[] = [];
    let userCardForAmy: string[] = [];
    if (memoryPolicy !== "none") {
      await honcho.ensureSessionExists(config, sessionId);
      await honcho.setUserObserveConfig(config, sessionId);
      [userCard, userCardForAmy] = await Promise.all([honcho.getUserCard(config), honcho.getUserCardForAmy(config)]);
    }

    // Phase 6a: no extra LLM call, just shapes the one generation this
    // turn already makes. Fires for turns likely to take a while -
    // needsPlanning, background, or a research/web capability classified.
    const narrateBeforeSlowAnswer =
      needsPlanning || background || relevantGroups.includes("research") || relevantGroups.includes("web");

    const systemPrompt = buildSystemPrompt({
      personaSystemPrompt: personaSystemPrompt ?? FALLBACK_PERSONA,
      now: new Date(),
      userCard,
      userCardForAmy,
      skillsCatalogText: formatSkillsCatalog(activeSkills),
      relevantMemories,
      openTasks,
      relevantGoals,
      needsPlanningNudge: needsPlanning,
      narrateBeforeSlowAnswer,
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

    const boundToolNames = tools.map((t) => t.name);
    emit("trace", undefined, {
      kind: "classify",
      boundTools: boundToolNames,
      relevantGroups,
      toolPolicy,
      memoryPolicy,
      needsPlanning,
      background,
      openTasks,
      relevantGoals,
      memories: memoryResults.map((m) => ({ content: m.content, domain: m.domain, score: m.score })),
    });

    emit("begin");

    const calledTools: string[] = [];
    let attempt = 0;
    const runTurn = (userPrompt: string) => {
      attempt++;
      const thisAttempt = attempt;
      return runAgentLoop({
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
        onTrace: (event) => emit("trace", undefined, { ...event, attempt: thisAttempt }),
      });
    };

    let result = await runTurn(chatInput);

    // One-shot empty-output retry - same shape as coding-orchestrator's
    // own runCoderRound retry, applied here since a raw tool-calling loop
    // can still occasionally return nothing on a given attempt.
    if (!result.output.trim()) {
      emit("trace", undefined, { kind: "retry", attempt: attempt + 1, reason: "empty_output" });
      result = await runTurn(chatInput);
    }

    let finalText = result.output.trim()
      ? result.output
      : "No response was generated for that message — try asking again.";

    // One-shot unfulfilled-search-intent retry.
    if (hasUnfulfilledSearchIntent(finalText, boundToolNames, calledTools)) {
      emit("trace", undefined, { kind: "retry", attempt: attempt + 1, reason: "search_intent" });
      const retry = await runTurn(chatInput + SEARCH_RETRY_NUDGE);
      if (retry.output.trim()) finalText = retry.output;
    }

    // One-shot confabulated-action retry - explicitly tell the model it
    // claimed a completed action without calling the tool that would
    // actually do it, and to either really call it or stop claiming it did.
    if (isConfabulatedAction(finalText, boundToolNames, calledTools)) {
      emit("trace", undefined, { kind: "retry", attempt: attempt + 1, reason: "confabulation" });
      const retry = await runTurn(
        chatInput +
          " (Your last reply claimed to have done something, but no matching tool was actually called - " +
          "either actually call the right tool now, or answer without claiming you did.)",
      );
      if (retry.output.trim()) finalText = retry.output;
    }

    // Tool policy enforcement: toolPolicy=required means the classifier
    // decided this message can't be answered correctly without checking a
    // real tool first. One retry with an explicit nudge; if the required
    // tool still wasn't called, the reply is replaced with a fixed,
    // non-LLM template rather than whatever the model said - an
    // LLM-generated "I failed" message can itself still confabulate
    // (elaborate on wrong information instead of admitting it didn't
    // check), so this is the one guarantee in this whole safety net that
    // isn't itself model output.
    if (hasUnsatisfiedRequiredTool(toolPolicy, boundToolNames, calledTools)) {
      emit("trace", undefined, { kind: "retry", attempt: attempt + 1, reason: "required_tool" });
      const retry = await runTurn(chatInput + REQUIRED_TOOL_RETRY_NUDGE);
      if (retry.output.trim()) finalText = retry.output;

      if (hasUnsatisfiedRequiredTool(toolPolicy, boundToolNames, calledTools)) {
        finalText = REQUIRED_TOOL_FAILURE_MESSAGE;
      }
    }

    emit("item", finalText);
    emit("end");
    res.end();

    // Unconditional regardless of memoryPolicy, same as honcho.storeTurn/
    // sessionMemory.appendTurn - memoryPolicy only ever gates retrieval
    // into a turn's prompt, never storage, so a memoryPolicy=none turn
    // still gets recorded for a future turn's cross-conversation search.
    // Phase 3b metadata tagging: domain = this turn's classified
    // capability groups (comma-joined - a different vocabulary from
    // knowledge-engine's free-text world-fact domains, see the
    // migration's own comment); taskContextId = the most-recently-updated
    // open task, if any was open when this turn happened. Both optional,
    // undefined when there's nothing to tag.
    const memoryDomain = relevantGroups.length ? relevantGroups.join(",") : undefined;
    const memoryTaskContextId = openTasks[0]?.id;
    await Promise.all([
      honcho.storeTurn(config, sessionId, chatInput, finalText),
      sessionMemory.appendTurn(config, sessionId, chatInput, finalText),
      ingestMemory(config, sessionId, "user", chatInput, memoryDomain, memoryTaskContextId),
      ingestMemory(config, sessionId, "assistant", finalText, memoryDomain, memoryTaskContextId),
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
