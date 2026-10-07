"use client";

import { useEffect, useState } from "react";

// Same token-estimate convention chat-orchestrator/src/agent-loop.ts already
// uses (CHARS_PER_TOKEN_ESTIMATE = 4) - reused here rather than inventing a
// second estimate.
const CHARS_PER_TOKEN_ESTIMATE = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

interface Section {
  label: string;
  description: string;
  // "real": size comes from data this component actually fetched.
  // "varies": per-turn dynamic, size depends on this turn's classification -
  //   see the Trace tab, not reconstructed here.
  // "fixed": a static instruction string baked into system-prompt.ts/
  //   system_prompt.py - deliberately NOT duplicated into the frontend
  //   (that would silently drift from the real source), so no number.
  kind: "real" | "varies" | "fixed";
  tokens?: number;
}

// Mirrors chat-orchestrator/src/system-prompt.ts's buildSystemPrompt clause
// order (ported 1:1 to agent-service/src/system_prompt.py, the live path -
// see this session's memory note on that duplication).
const STATIC_SECTIONS: Omit<Section, "tokens">[] = [
  { label: "Current date/time", description: "Pacific time, injected fresh every turn as ground truth for relative dates.", kind: "fixed" },
  { label: "Response style", description: "Standing rule: concise, synthesized answers, not raw tool-output dumps.", kind: "fixed" },
  { label: "Tool-error handling", description: "Standing rule: diagnose and retry a failed tool call in the same reply, don't just say 'I'll check later'.", kind: "fixed" },
  { label: "Relevant memories", description: "Cross-conversation recall from memory-engine, filtered by this turn's memory policy.", kind: "varies" },
  { label: "Open tasks", description: "Every open task_context, shown every turn regardless of memory policy.", kind: "varies" },
  { label: "Relevant goals", description: "Goals keyword-matched to this message.", kind: "varies" },
  { label: "Needs-planning nudge", description: "One-time nudge to plan a multi-step task before attempting it.", kind: "varies" },
  { label: "Narrate-before-slow-answer", description: "Told to narrate what it's about to do when a turn will likely take a while.", kind: "varies" },
  { label: "Skills catalog", description: "The full list of skills Amy has learned.", kind: "fixed" },
];

function SectionRow({ section }: { section: Section }) {
  return (
    <li className="rounded-xl border border-white/10 bg-zinc-900/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-zinc-200">{section.label}</p>
        {section.kind === "real" && section.tokens !== undefined && (
          <span className="shrink-0 rounded-full bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-indigo-300">
            ~{section.tokens} tok
          </span>
        )}
        {section.kind === "varies" && (
          <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-amber-300">
            varies by turn
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-zinc-500">{section.description}</p>
    </li>
  );
}

export function SystemPromptView() {
  const [personaTokens, setPersonaTokens] = useState<number | null>(null);
  const [userCardTokens, setUserCardTokens] = useState<number | null>(null);
  const [userCardForAmyTokens, setUserCardForAmyTokens] = useState<number | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    Promise.all([
      fetch("/api/amy/persona").then((res) => (res.ok ? res.json() : Promise.reject())),
      fetch("/api/amy/user-profile").then((res) => (res.ok ? res.json() : Promise.reject())),
    ])
      .then(([persona, profile]) => {
        setPersonaTokens(estimateTokens(persona.systemPrompt ?? ""));
        setUserCardTokens(estimateTokens((profile.userCard ?? []).join(" ")));
        setUserCardForAmyTokens(estimateTokens((profile.userCardForAmy ?? []).join(" ")));
      })
      .catch(() => setError("Couldn't reach chat-orchestrator."));
  }, []);

  const realSections: Section[] = [
    { label: "Persona", description: "Amy's core persona text, loaded from the active persona record.", kind: "real", tokens: personaTokens ?? undefined },
    { label: "User card", description: "What Amy knows about you (Honcho's peer card).", kind: "real", tokens: userCardTokens ?? undefined },
    { label: "User card for Amy", description: "Standing instructions you've given about how Amy should behave.", kind: "real", tokens: userCardForAmyTokens ?? undefined },
  ];

  const total =
    personaTokens !== null && userCardTokens !== null && userCardForAmyTokens !== null
      ? personaTokens + userCardTokens + userCardForAmyTokens
      : null;

  return (
    <div>
      <p className="mb-3 text-xs text-zinc-500">
        Every named section chat-orchestrator&apos;s buildSystemPrompt assembles, in order. Token counts are a live
        estimate (chars/4, same convention agent-loop.ts already uses) of the sections with real fetched data right
        now - not a reconstruction of any single turn&apos;s exact assembled prompt. Fixed boilerplate sections show
        no number rather than a guessed one; per-turn sections vary with this session&apos;s Trace tab.
      </p>
      {error && <p className="mb-3 text-xs text-rose-400">{error}</p>}
      {total !== null && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-900/40 p-3">
          <p className="font-mono text-2xl font-semibold text-zinc-100">~{total}</p>
          <p className="text-[10px] uppercase tracking-wide text-zinc-600">
            tokens, live, across persona + both user cards only
          </p>
        </div>
      )}
      <ul className="space-y-2">
        {realSections.map((s) => (
          <SectionRow key={s.label} section={s} />
        ))}
        {STATIC_SECTIONS.map((s) => (
          <SectionRow key={s.label} section={s} />
        ))}
      </ul>
    </div>
  );
}
