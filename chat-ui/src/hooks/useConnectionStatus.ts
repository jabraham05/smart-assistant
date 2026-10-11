import { useEffect, useState } from "react";

const POLL_MS = 15_000;
const TIMEOUT_MS = 5_000;

// Tracks whether this client can currently reach the chat-ui server: raw
// network state (navigator.onLine) plus a periodic /api/health poll, so a
// reachable-but-wedged server (e.g. mid-restart) also surfaces as offline.
export function useConnectionStatus() {
  // Node 22+ exposes a minimal global `navigator` (just userAgent/language,
  // no `.onLine`), so feature-detecting via `typeof navigator` alone passes
  // on the server and reads `undefined` - guard on `window` instead, which
  // only ever exists in the browser.
  const [online, setOnline] = useState(() => (typeof window === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);

    let cancelled = false;
    const poll = async () => {
      if (!navigator.onLine) return;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const res = await fetch("/api/health", { cache: "no-store", signal: controller.signal });
        clearTimeout(timer);
        if (!cancelled) setOnline(res.ok);
      } catch {
        if (!cancelled) setOnline(false);
      }
    };

    poll();
    const interval = setInterval(poll, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  return online;
}
