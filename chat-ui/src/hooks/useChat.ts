"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChatMessage, HonchoMessage, N8nStreamEvent } from "@/types/chat";
import { isRetryEvent, reduceMessage as reduceMessageEvent } from "@/lib/message-reducer";

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

      // The actual reducer logic lives in lib/message-reducer.ts (pure, no
      // React/DOM - testable on its own, see its test file). This wrapper
      // just keeps accumulatedContent in sync, since that's tracked outside
      // the pure reducer for the end-of-stream blank-message check below.
      const reduceMessage = (m: ChatMessage, event: N8nStreamEvent): ChatMessage => {
        if (
          (event.type === "item" || event.type === "ack") &&
          event.metadata.nodeName === "AI Agent" &&
          event.content
        ) {
          accumulatedContent += event.content;
        }
        return reduceMessageEvent(m, event, openSteps);
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
        // Mirrors reduceMessage's own content reset on a retry trace event -
        // accumulatedContent is tracked outside the pure reducer, so it
        // needs its own reset here to match, or the end-of-stream
        // blank-message check below could still think the turn produced
        // real content from an attempt that was actually discarded.
        if (isRetryEvent(event)) {
          accumulatedContent = "";
        }
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
