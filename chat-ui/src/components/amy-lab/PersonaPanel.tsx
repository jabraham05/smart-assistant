"use client";

import { useEffect, useState } from "react";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import type { PersonaSnapshot } from "@/lib/chat-orchestrator-client";

// Replaces the old hardcoded SYSTEM_PROMPT_SECTIONS structural description
// with the real, live persona text + active instruction skills, via the
// new GET /api/persona-snapshot (chat-orchestrator/src/index.ts). Read-only
// - persona editing still only ever happens in n8n's Data Table UI, same
// standing convention as everywhere else in this project.
export function PersonaPanel() {
  const [snapshot, setSnapshot] = useState<PersonaSnapshot | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/persona-snapshot")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: PersonaSnapshot) => {
        if (!cancelled) setSnapshot(data);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't reach chat-orchestrator.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (isLoading) return <p className="text-xs text-zinc-600">Loading…</p>;
  if (error) return <p className="text-xs text-rose-400">{error}</p>;
  if (!snapshot) return null;

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs text-zinc-500">
          Amy&apos;s real, live persona text - read-only here. Editing happens only in n8n&apos;s Data Table UI.
        </p>
        <div className="rounded-xl border border-white/10 bg-zinc-900/40 p-4">
          <MarkdownContent content={snapshot.personaSystemPrompt} isUser={false} />
        </div>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium text-zinc-400">
          Active instruction skills ({snapshot.activeSkills.length})
        </p>
        {snapshot.activeSkills.length === 0 && <p className="text-xs text-zinc-600">None active.</p>}
        <ul className="space-y-2">
          {snapshot.activeSkills.map((skill) => (
            <li key={skill.name} className="rounded-xl border border-white/10 bg-zinc-900/40 p-3.5">
              <p className="text-sm font-medium text-zinc-200">{skill.name}</p>
              <p className="mt-0.5 text-xs text-zinc-500">{skill.description}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
