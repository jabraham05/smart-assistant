"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/chat", label: "Chat" },
  { href: "/artifacts", label: "Artifacts" },
  { href: "/amy-lab", label: "Amy Lab" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 border-b border-gray-200 px-4 py-2 dark:border-gray-700">
      {LINKS.map(({ href, label }) => {
        const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`rounded px-3 py-1 text-sm font-medium ${
              isActive
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
                : "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
