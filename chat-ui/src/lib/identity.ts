// Which Amy identity (agent-service's config.is_test_user) this browser's
// conversations are attributed to. Replaces relying on sessionId shape
// (the old "test-" prefix convention) with an explicit choice - defaults
// to "test" on first load so a fresh browser/profile never silently
// writes into a real identity's Honcho/Postgres data until the user picks
// one deliberately.
const STORAGE_KEY = "amyUserId";
export const DEFAULT_USER_ID = "test";

// Baked in at build time (see docker-compose.yml's NEXT_PUBLIC_AMY_USER_IDS) -
// comma-separated, first entry doubles as the fallback default. Always
// includes "test" even if misconfigured, so there's always a safe choice.
export function getAvailableUserIds(): string[] {
  const raw = process.env.NEXT_PUBLIC_AMY_USER_IDS || DEFAULT_USER_ID;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(DEFAULT_USER_ID) ? ids : [...ids, DEFAULT_USER_ID];
}

export function getStoredUserId(): string {
  if (typeof window === "undefined") return DEFAULT_USER_ID;
  return window.localStorage.getItem(STORAGE_KEY) || DEFAULT_USER_ID;
}

export function setStoredUserId(userId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, userId);
}
