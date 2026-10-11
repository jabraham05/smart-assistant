import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, isValidSessionToken } from "@/lib/auth";

// Reachable without a session: the login page/API itself, the health
// check the connection banner polls before a user is necessarily logged
// in, and the PWA install assets a browser fetches on its own (manifest,
// icons) - none of these expose any Amy data.
const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/health",
  "/manifest.webmanifest",
  "/apple-icon.png",
  "/icon-192x192.png",
  "/icon-512x512.png",
  "/favicon.ico",
]);

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  // Browser clients (the PWA) carry the session as a cookie. Native
  // clients have no cookie jar to speak of, so they send the same token
  // as a bearer header instead - same isValidSessionToken check either
  // way, the token format doesn't care how it was transmitted.
  const authHeader = request.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
  const token = bearerToken ?? request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (isValidSessionToken(token)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
