"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LogoutButton } from "./LogoutButton";

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v9a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1v-9" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v10a1.5 1.5 0 0 1-1.5 1.5H9l-4.5 4v-4H5.5A1.5 1.5 0 0 1 4 15.5z" />
    </svg>
  );
}

function ArtifactsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
      <path d="M3 7.5 12 3l9 4.5-9 4.5-9-4.5Z" />
      <path d="M3 12l9 4.5 9-4.5" />
      <path d="M3 16.5 12 21l9-4.5" />
    </svg>
  );
}

function LabIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
      <path d="M9.5 3h5" />
      <path d="M10.5 3v6.2L5.3 18.4A1.8 1.8 0 0 0 6.85 21h10.3a1.8 1.8 0 0 0 1.55-2.6L13.5 9.2V3" />
      <path d="M7.5 15h9" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
      <path d="M15 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H15" />
      <path d="M10 12h10M17 8.5 20.5 12 17 15.5" />
    </svg>
  );
}

const LINKS: { href: string; label: string; icon: () => ReactNode }[] = [
  { href: "/", label: "Home", icon: HomeIcon },
  { href: "/chat", label: "Chat", icon: ChatIcon },
  { href: "/artifacts", label: "Artifacts", icon: ArtifactsIcon },
  { href: "/amy-lab", label: "Amy Lab", icon: LabIcon },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <>
      {/* Desktop/tablet: fixed left column. */}
      <nav className="hidden h-full w-60 shrink-0 flex-col border-r border-white/10 bg-zinc-950/70 backdrop-blur-sm md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-400" />
          </span>
          <span className="text-sm font-semibold tracking-wide text-zinc-100">Amy</span>
        </div>

        <div className="flex-1 space-y-0.5 px-3">
          {LINKS.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                className={`group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-indigo-500/10 font-medium text-indigo-300"
                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                }`}
              >
                <span className={active ? "text-indigo-400" : "text-zinc-500 group-hover:text-zinc-300"}>
                  <Icon />
                </span>
                {label}
              </Link>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-white/10 px-5 py-3">
          <p className="font-mono text-[10px] tracking-wide text-zinc-600">smart-assistant</p>
          {pathname !== "/login" && (
            <LogoutButton className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-300">
              Log out
            </LogoutButton>
          )}
        </div>
      </nav>

      {/* Mobile: fixed bottom tab bar, inset for the iPhone home indicator. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 flex border-t border-white/10 bg-zinc-950/90 backdrop-blur-sm md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] transition-colors ${
                active ? "text-indigo-300" : "text-zinc-500"
              }`}
            >
              <Icon />
              {label}
            </Link>
          );
        })}
        {pathname !== "/login" && (
          <LogoutButton className="flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] text-zinc-500 transition-colors">
            <LogoutIcon />
            Log out
          </LogoutButton>
        )}
      </nav>
    </>
  );
}
