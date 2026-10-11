"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

export function LogoutButton({ className, children }: { className?: string; children: ReactNode }) {
  const router = useRouter();

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  };

  return (
    <button type="button" onClick={handleLogout} className={className}>
      {children}
    </button>
  );
}
