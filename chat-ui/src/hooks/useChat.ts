"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChatMessage, HonchoMessage, N8nStreamEvent, StepEvent } from "@/types/chat";
import { classifyNode } from "@/lib/step-classifier";

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
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setIsSending(true);

      // Tracks which step index is currently "open" (running) for a given
      // nodeId, so a second begin/end cycle for the same node (e.g. the AI
      // Agent thinking again after a tool call) becomes a new step entry
      // instead of overwriting the first.
      const openSteps = new Map<string, number>();
      // Tracked separately from React state (which updates async via the
      // functional setMessages below) so the post-stream check can read a
      // definitive answer synchronously once the reader loop finishes.
      let accumulatedContent = "";

      const applyEvent = (event: N8nStreamEvent) => {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantMessageId) return m;

            const steps = [...(m.steps ?? [])];
            const rawEvents = [...(m.rawEvents ?? []), event];
            const { nodeId, nodeName, timestamp } = event.metadata;

            if (event.type === "begin") {
              const { kind, label } = classifyNode(nodeName);
              const step: StepEvent = {
                nodeId,
                nodeName,
                kind,
                label,
                status: "running",
                startedAt: timestamp,
              };
              openSteps.set(nodeId, steps.length);
              steps.push(step);
              return { ...m, steps, rawEvents };
            }

            if (event.type === "item") {
              // AI Agent's streamed tokens are the actual reply text.
              if (nodeName === "AI Agent" && event.content) {
                accumulatedContent += event.content;
                return { ...m, content: m.content + event.content, steps, rawEvents };
              }
              return { ...m, rawEvents };
            }

            if (event.type === "end") {
              const idx = openSteps.get(nodeId);
              if (idx !== undefined && steps[idx]) {
                steps[idx] = { ...steps[idx], status: "done", finishedAt: timestamp };
                openSteps.delete(nodeId);
              }
              return { ...m, steps, rawEvents };
            }

            if (event.type === "error") {
              const idx = openSteps.get(nodeId);
              if (idx !== undefined && steps[idx]) {
                steps[idx] = { ...steps[idx], status: "error", finishedAt: timestamp };
                openSteps.delete(nodeId);
              } else {
                const { kind, label } = classifyNode(nodeName);
                steps.push({
                  nodeId,
                  nodeName,
                  kind,
                  label,
                  status: "error",
                  startedAt: timestamp,
                  finishedAt: timestamp,
                });
              }
              return { ...m, steps, rawEvents };
            }

            return m;
          })
        );
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
