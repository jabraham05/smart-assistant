"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useActiveSession } from "@/contexts/ActiveSessionContext";
import { SessionList } from "@/components/chat/SessionList";
import { LogoutButton } from "./LogoutButton";

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v9a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1v-9" />
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

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

const LINKS: { href: string; label: string; icon: () => ReactNode }[] = [
  { href: "/home", label: "Home", icon: HomeIcon },
  { href: "/artifacts", label: "Artifacts", icon: ArtifactsIcon },
  { href: "/amy-lab", label: "Amy Lab", icon: LabIcon },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

// Shared between the persistent desktop column and the mobile slide-over -
// same content either way. Chat (the default "/" route) gets the
// conversation list; every other page just gets the nav links, since
// there's no active conversation to switch between there.
function DrawerContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { sessions, activeSessionId, setActiveSessionId, startNewSession, isLoading } = useActiveSession();
  const isChatRoute = pathname === "/" || pathname === "/chat";

  return (
    <div className="flex h-full w-72 flex-col border-r border-white/10 bg-zinc-950">
      <Link
        href="/"
        onClick={onNavigate}
        className="flex shrink-0 items-center gap-2 px-5 py-5"
        style={{ paddingTop: "calc(1.25rem + env(safe-area-inset-top))" }}
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-400" />
        </span>
        <span className="text-sm font-semibold tracking-wide text-zinc-100">Amy</span>
      </Link>

      {isChatRoute && (
        <div className="min-h-0 flex-1">
          <SessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={(id) => {
              setActiveSessionId(id);
              onNavigate?.();
            }}
            onNewSession={() => {
              startNewSession();
              onNavigate?.();
            }}
            isLoading={isLoading}
          />
        </div>
      )}

      <div className="shrink-0 space-y-0.5 border-t border-white/10 px-3 py-2">
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
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

      <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-5 py-3">
        <p className="font-mono text-[10px] tracking-wide text-zinc-600">smart-assistant</p>
        {pathname !== "/login" && (
          <LogoutButton className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-300">
            Log out
          </LogoutButton>
        )}
      </div>
    </div>
  );
}

export function AppDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Desktop: persistent left column. */}
      <div className="hidden md:flex md:h-full">
        <DrawerContent />
      </div>

      {/* Mobile: slim top bar (normal document flow, not fixed - avoids
          overlapping each page's own header content) with a hamburger that
          opens a slide-over drawer. */}
      <div
        className="flex items-center gap-3 border-b border-white/10 px-4 py-3 md:hidden"
        style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top))" }}
      >
        <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="text-zinc-400">
          <MenuIcon />
        </button>
        <span className="text-sm font-semibold tracking-wide text-zinc-100">Amy</span>
      </div>

      {open && (
        <div className="fixed inset-0 z-30 flex md:hidden">
          <div className="w-72 max-w-[85vw]">
            <DrawerContent onNavigate={() => setOpen(false)} />
          </div>
          <button
            type="button"
            aria-label="Close menu"
            className="flex-1 bg-black/50"
            onClick={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}
