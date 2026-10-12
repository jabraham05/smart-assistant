import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Single shared-secret login, since this is a single-user system (see
// docs/iphone-pwa-implementation-plan.md section 8) - no user table, no
// per-user sessions, just "knows the password or doesn't".
export const SESSION_COOKIE_NAME = "amy_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

function digest(input: string) {
  return createHash("sha256").update(input).digest();
}

function hmac(input: string) {
  const secret = process.env.AMY_AUTH_PASSWORD;
  if (!secret) throw new Error("AMY_AUTH_PASSWORD is not set");
  return createHmac("sha256", secret).update(input).digest("hex");
}

// Fixed-length digests either side so timingSafeEqual never throws on a
// length mismatch (and comparing raw variable-length strings would leak
// length/prefix timing anyway).
export function checkPassword(candidate: string): boolean {
  const expected = process.env.AMY_AUTH_PASSWORD;
  if (!expected) return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

export function createSessionToken(): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  return `${expiresAt}.${hmac(String(expiresAt))}`;
}

export function isValidSessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const [expiresAtRaw, signature] = token.split(".");
  if (!expiresAtRaw || !signature) return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  try {
    const expected = Buffer.from(hmac(expiresAtRaw), "hex");
    const actual = Buffer.from(signature, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
