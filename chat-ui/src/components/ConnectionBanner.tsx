"use client";

import { useConnectionStatus } from "@/hooks/useConnectionStatus";

export function ConnectionBanner() {
  const online = useConnectionStatus();
  if (online) return null;

  return (
    <div className="flex shrink-0 items-center justify-center gap-2 bg-amber-500/90 px-3 py-1.5 text-center text-xs font-medium text-zinc-950">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-zinc-950 opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-zinc-950" />
      </span>
      Can&apos;t reach Amy &mdash; reconnecting&hellip;
    </div>
  );
}
