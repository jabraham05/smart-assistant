"use client";

import { useEffect, useMemo, useState } from "react";

interface UserProfile {
  userCard: string[];
  userCardForAmy: string[];
}

interface Entity {
  id: string;
  name: string;
  description: string | null;
}

function CardList({ title, description, items }: { title: string; description: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-white/10 bg-zinc-900/40 p-4">
      <p className="text-sm font-medium text-zinc-200">{title}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{description}</p>
      {items.length === 0 ? (
        <p className="mt-3 text-xs text-zinc-600">Nothing recorded yet.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="rounded-lg border border-white/5 bg-white/[0.02] p-2 text-xs text-zinc-300">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Honcho's card is a flat string[] with no real schema (confirmed against
// scripts/set-peer-cards.mjs and chat-orchestrator/src/honcho.ts - there's
// no Honcho API that exposes separate structured fields, only this one
// array per peer/target). This repo's own bootstrap convention labels some
// lines ("Name: ...", "Age: ...") and leaves others as plain sentences -
// best-effort split on that convention, not a real schema. The reliable
// structure comes from the entities below instead, which DO have a real
// `type` column.
const IDENTITY_PREFIXES = ["name", "age", "location", "city", "address", "job", "occupation", "education"];

function splitByIdentityPrefix(lines: string[]): { identity: string[]; other: string[] } {
  const identity: string[] = [];
  const other: string[] = [];
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z ]*):\s*/.exec(line);
    if (match && IDENTITY_PREFIXES.includes(match[1].toLowerCase())) {
      identity.push(line);
    } else {
      other.push(line);
    }
  }
  return { identity, other };
}

export function UserProfileView() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [facts, setFacts] = useState<Entity[]>([]);
  const [preferences, setPreferences] = useState<Entity[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setIsLoading(true);
    Promise.all([
      fetch("/api/amy/user-profile").then((res) => (res.ok ? res.json() : Promise.reject())),
      fetch("/api/entities?type=fact")
        .then((res) => (res.ok ? res.json() : { entities: [] }))
        .catch(() => ({ entities: [] })),
      fetch("/api/entities?type=preference")
        .then((res) => (res.ok ? res.json() : { entities: [] }))
        .catch(() => ({ entities: [] })),
    ])
      .then(([profileData, factsData, preferencesData]) => {
        setProfile(profileData);
        setFacts(factsData.entities ?? []);
        setPreferences(preferencesData.entities ?? []);
      })
      .catch(() => setError("Couldn't reach Honcho."))
      .finally(() => setIsLoading(false));
  }, []);

  const { identity, other } = useMemo(() => splitByIdentityPrefix(profile?.userCard ?? []), [profile]);

  return (
    <div>
      {isLoading && <p className="text-xs text-zinc-600">Loading…</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!isLoading && !error && profile && (
        <div className="space-y-3">
          <CardList
            title="Identity"
            description="Honcho's peer card, lines matching a recognized name/age/location-style prefix."
            items={identity}
          />
          <CardList
            title="Facts"
            description="Promoted from real conversations (knowledge-engine entities, type=fact)."
            items={facts.map((f) => f.description ?? f.name)}
          />
          <CardList
            title="Preferences"
            description="Promoted from real conversations (knowledge-engine entities, type=preference)."
            items={preferences.map((p) => p.description ?? p.name)}
          />
          <CardList
            title="Other things Amy knows"
            description="Honcho's peer card, everything else - best-effort, not a real schema."
            items={other}
          />
        </div>
      )}
    </div>
  );
}

export function UserInstructionsView() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setIsLoading(true);
    fetch("/api/amy/user-profile")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setProfile(data))
      .catch(() => setError("Couldn't reach Honcho."))
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <div>
      <p className="mb-3 text-xs text-zinc-500">
        Standing instructions you&apos;ve given Amy about how she should behave - Honcho&apos;s directional peer
        card, kept up to date automatically from real conversations.
      </p>
      {isLoading && <p className="text-xs text-zinc-600">Loading…</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!isLoading && !error && profile && (
        <CardList
          title="Standing instructions you've given Amy"
          description="Behavioral instructions directed at how Amy should act."
          items={profile.userCardForAmy}
        />
      )}
    </div>
  );
}
