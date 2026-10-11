"use client";

import type { ReactNode } from "react";

export function LogoutButton({ className, children }: { className?: string; children: ReactNode }) {
  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    // Hard navigation (see login/page.tsx for why): also drops any
    // now-stale authenticated pages out of the client Router Cache.
    window.location.href = "/login";
  };

  return (
    <button type="button" onClick={handleLogout} className={className}>
      {children}
    </button>
  );
}
