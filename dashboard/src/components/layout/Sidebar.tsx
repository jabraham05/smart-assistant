"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/activity", label: "Activity" },
  { href: "/chat", label: "Chat" },
  { href: "/workflows", label: "Workflows" },
  { href: "/registry", label: "Agent Registry" },
  { href: "/database", label: "Database" },
  { href: "/knowledge", label: "Knowledge Search" },
  { href: "/logs", label: "Logs" },
  { href: "/docs", label: "Docs" },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex h-full w-48 shrink-0 flex-col gap-1 border-r border-black/10 bg-black/[.02] p-3 dark:border-white/10 dark:bg-white/[.02]">
      <div className="mb-3 px-2 text-sm font-semibold tracking-wide text-black/60 dark:text-white/60">
        Ops Dashboard
      </div>
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-md px-2 py-1.5 text-sm ${
              active
                ? "bg-black/10 font-medium dark:bg-white/10"
                : "text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/5"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
