"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChatMessage, HonchoMessage, N8nStreamEvent } from "@/types/chat";
import { classifyTool } from "@/lib/step-classifier";

function honchoMessagesToChat(messages: HonchoMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.peer_id === "user" ? "user" : "assistant",
    content: m.content,
  }));
}

export function useChat(sessionId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingHistory(true);
    setMessages([]);

    fetch(`/api/sessions/${sessionId}/messages`)
      .then((res) => (res.ok ? res.json() : []))
      .then((history: HonchoMessage[]) => {
        if (!cancelled) setMessages(honchoMessagesToChat(history));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingHistory(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const sendMessage = useCallback(
    async (content: string) => {
      const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content };
      const assistantMessageId = crypto.randomUUID();
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        steps: [],
        rawEvents: [],
        trace: [],
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setIsSending(true);

      // Tracks which step index is currently "open" (running) for a given
      // tool call, keyed by attempt:iteration:name, so its matching
      // tool_result (not a later call to the same tool) closes it out.
      const openSteps = new Map<string, number>();
      // Tracked separately from React state (which updates async via the
      // functional setMessages below) so the post-stream check can read a
      // definitive answer synchronously once the reader loop finishes.
      let accumulatedContent = "";

      // Pure per-event reducer, pulled out of applyEvent so a whole batch of
      // queued events (see below) can be folded into one message object
      // before a single setMessages commit, instead of one commit per event.
      const reduceMessage = (m: ChatMessage, event: N8nStreamEvent): ChatMessage => {
        const steps = [...(m.steps ?? [])];
        const rawEvents = [...(m.rawEvents ?? []), event];
        const { nodeId, nodeName, timestamp } = event.metadata;

        if (event.type === "item") {
          // AI Agent's streamed tokens are the actual reply text.
          if (nodeName === "AI Agent" && event.content) {
            accumulatedContent += event.content;
            return { ...m, content: m.content + event.content, rawEvents };
          }
          return { ...m, rawEvents };
        }

        if (event.type === "trace" && event.trace) {
          const trace = [...(m.trace ?? []), event.trace];

          if (event.trace.kind === "tool_call") {
            const { attempt, iteration, name } = event.trace;
            const key = `${attempt}:${iteration}:${name}`;
            const { kind, label } = classifyTool(name);
            openSteps.set(key, steps.length);
            steps.push({
              nodeId: key,
              nodeName: name,
              kind,
              label,
              status: "running",
              startedAt: timestamp,
            });
          }

          if (event.trace.kind === "tool_result") {
            const { attempt, iteration, name, isError } = event.trace;
            const key = `${attempt}:${iteration}:${name}`;
            const idx = openSteps.get(key);
            if (idx !== undefined && steps[idx]) {
              steps[idx] = { ...steps[idx], status: isError ? "error" : "done", finishedAt: timestamp };
              openSteps.delete(key);
            }
          }

          return { ...m, steps, rawEvents, trace };
        }

        if (event.type === "error") {
          steps.push({
            nodeId,
            nodeName,
            kind: "other",
            label: "Something went wrong",
            status: "error",
            startedAt: timestamp,
            finishedAt: timestamp,
          });
          return { ...m, steps, rawEvents };
        }

        return { ...m, rawEvents };
      };

      // Real, live-verified finding: chat-orchestrator (the previous
      // backend) only ever emitted ONE "item" event per turn, the full
      // reply already assembled - MarkdownContent's full react-markdown
      // re-parse on every content change was never exercised more than
      // once per turn. agent-service streams real token-by-token deltas
      // (confirmed live: a short reply alone produced 30+ separate "item"
      // events), and applyEvent previously called setMessages - and so a
      // full markdown re-parse of the whole growing message - on every
      // single one. On a longer reply this saturated the render loop badly
      // enough to freeze/crash the tab (reported live: "page crashes when
      // I chat to Amy"). Batched here via requestAnimationFrame - each
      // animation frame folds every event that arrived since the last
      // frame into one setMessages commit, capping re-renders at the
      // browser's own paint rate regardless of how fast tokens arrive.
      let pending: N8nStreamEvent[] = [];
      let flushScheduled = false;
      const flush = () => {
        flushScheduled = false;
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMessageId ? batch.reduce(reduceMessage, m) : m))
        );
      };
      const applyEvent = (event: N8nStreamEvent) => {
        pending.push(event);
        if (!flushScheduled) {
          flushScheduled = true;
          requestAnimationFrame(flush);
        }
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: content, sessionId }),
        });

        if (!res.ok || !res.body) {
          throw new Error(`Chat request failed with ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              applyEvent(JSON.parse(trimmed) as N8nStreamEvent);
            } catch {
              // Non-JSON line (shouldn't happen with responseMode=streaming); skip it.
            }
          }
        }

        if (buffer.trim()) {
          try {
            applyEvent(JSON.parse(buffer.trim()) as N8nStreamEvent);
          } catch {
            // ignore trailing partial line
          }
        }

        // Explicit final flush, not left to the next requestAnimationFrame -
        // rAF doesn't fire for a backgrounded tab, which could otherwise
        // strand the last few tokens out of view until the tab regains
        // focus.
        flush();

        // The stream can end with zero AI Agent tokens (a known, documented
        // reliability gap - the fallback chain that corrects Honcho/Postgres
        // memory for future turns runs *after* this response has already
        // closed, so there's nothing left to stream this turn). Without
        // this, the message renders as a literally blank bubble with no
        // indication anything happened.
        if (!accumulatedContent.trim()) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? { ...m, content: "No response was generated for that message — try asking again.", isEmpty: true }
                : m
            )
          );
        }
      } finally {
        setIsSending(false);
      }
    },
    [sessionId]
  );

  return { messages, isSending, isLoadingHistory, sendMessage };
}
