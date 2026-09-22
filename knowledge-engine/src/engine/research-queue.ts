import type { Config } from "../config.js";
import * as db from "../db.js";
import { checkKnowledge, runWebResearchAndPersist } from "./research.js";

export interface EnqueueInput {
  topic: string;
  domain?: string;
  originSessionId?: string;
  triggerSource?: string;
}

export interface EnqueueResult {
  queued: boolean;
  reason?: string;
  id?: number;
}

// The self-learning research queue's write path. Called from two places:
// chat-orchestrator, ambiently, whenever the Coordinator's classifier
// notices the user mentioning a topic Amy seems to know little about (see
// docs/chat-orchestrator.md's Coordinator section); and event-bus,
// deterministically, every time a new goal is created (see
// event-bus/src/index.ts's POST /goals) - a robust backstop independent of
// whether the classifier caught the moment. Dedup gate runs in cheapest-
// first order so a redundant enqueue never reaches the (comparatively
// expensive) knowledge-base check unnecessarily.
export async function enqueueTopic(config: Config, input: EnqueueInput): Promise<EnqueueResult> {
  const topic = input.topic.trim();
  if (!topic) return { queued: false, reason: "empty topic" };

  const exact = await db.findExactPendingTopic(config, topic);
  if (exact) return { queued: false, reason: `already queued as #${exact.id}` };

  const overlapping = await db.findOverlappingPendingTopic(config, topic, config.researchQueueDedupMinOverlap);
  if (overlapping) return { queued: false, reason: `overlaps already-queued #${overlapping.id} ("${overlapping.topic}")` };

  // Reuses the exact same deterministic knowledge-vs-web routing decision
  // /research already makes (engine/research.ts's checkKnowledge) - if
  // it's already well covered, there's nothing to queue. This is also why
  // this check runs last: it's a real hybrid-search query, more expensive
  // than the two lexeme/exact checks above.
  const { route } = await checkKnowledge(config, { query: topic, domain: input.domain });
  if (route.source === "knowledge") {
    return { queued: false, reason: `already known: ${route.reason}` };
  }

  const pendingCount = await db.countPendingResearchQueue(config);
  if (pendingCount >= config.researchQueueMaxPending) {
    return { queued: false, reason: `queue is full (${pendingCount}/${config.researchQueueMaxPending} pending)` };
  }

  const row = await db.insertResearchQueueEntry(config, {
    topic,
    domain: input.domain,
    originSessionId: input.originSessionId,
    triggerSource: input.triggerSource,
  });
  return { queued: true, id: row.id };
}

export interface DrainResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

// The self-learning research queue's read/drain path. Called from
// event-bus's wake-event trigger (POST /calendar/poll-check), sequentially
// (not parallel) to bound Ollama load during an idle/overnight run - one
// topic's full agent-loop run finishes before the next one starts. Each
// item's completion uses deferNotify:true, so it folds into event-bus's
// existing overnight-digest bullet list (getPendingDigestEvents) rather
// than needing any new notification path.
export async function drainQueue(config: Config, limit: number): Promise<DrainResult> {
  const claimed = await db.claimNextResearchQueueEntries(config, limit);
  let succeeded = 0;
  let failed = 0;

  for (const item of claimed) {
    try {
      const { route } = await checkKnowledge(config, { query: item.topic, domain: item.domain ?? undefined });
      if (route.source === "knowledge") {
        // Already covered by the time this got drained (e.g. a duplicate
        // topic was researched first earlier in the same drain run) -
        // nothing new to report, no digest entry needed.
        await db.updateResearchQueueStatus(config, item.id, "done");
        succeeded++;
        continue;
      }

      const session = await db.insertResearchSession(config, {
        topic: item.topic,
        domain: item.domain ?? undefined,
        triggerSource: "research_queue",
        originSessionId: item.origin_session_id ?? undefined,
      });

      await runWebResearchAndPersist(
        config,
        {
          query: item.topic,
          domain: item.domain ?? undefined,
          triggerSource: "research_queue",
          originSessionId: item.origin_session_id ?? undefined,
          deferNotify: true,
        },
        session.id,
      );

      const detail = await db.getResearchSessionDetail(config, session.id);
      const ok = detail?.session.status !== "failed";
      await db.updateResearchQueueStatus(config, item.id, ok ? "done" : "failed", session.id);
      if (ok) succeeded++;
      else failed++;
    } catch (e) {
      console.error(`research queue item ${item.id} failed:`, e);
      await db.updateResearchQueueStatus(config, item.id, "failed");
      failed++;
    }
  }

  return { attempted: claimed.length, succeeded, failed };
}
