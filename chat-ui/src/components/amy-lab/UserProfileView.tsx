"use client";

import { useEffect, useState } from "react";

interface UserProfile {
  userCard: string[];
  userCardForAmy: string[];
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

export function UserProfileView() {
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
        Honcho&apos;s peer cards - what Amy has learned about you, and any standing instructions you&apos;ve given
        about how she should behave. Both are kept up to date automatically from real conversations.
      </p>
      {isLoading && <p className="text-xs text-zinc-600">Loading…</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!isLoading && !error && profile && (
        <div className="space-y-3">
          <CardList title="What Amy knows about you" description="Durable facts, an evolving profile." items={profile.userCard} />
          <CardList
            title="Standing instructions you've given Amy"
            description="Behavioral instructions directed at how Amy should act."
            items={profile.userCardForAmy}
          />
        </div>
      )}
    </div>
  );
}
