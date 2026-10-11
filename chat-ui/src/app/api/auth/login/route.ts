import { NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  checkPassword,
  createSessionToken,
} from "@/lib/auth";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";

  if (!checkPassword(password)) {
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }

  // NODE_ENV is "production" in every Docker deployment of this app,
  // including plain-HTTP LAN testing before Tailscale/HTTPS is wired up
  // (see docs/iphone-pwa-implementation-plan.md section 8) - keying
  // `secure` off NODE_ENV marked the cookie Secure on plain HTTP, which
  // browsers silently refuse to store, so login appeared to do nothing.
  // Key off the actual request scheme instead: respects a TLS-terminating
  // reverse proxy's x-forwarded-proto, falls back to the request's own.
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");

  // Token returned in the body too, for a native client with no cookie
  // jar to store (Keychain) and send back as `Authorization: Bearer
  // <token>` - see proxy.ts. The browser PWA ignores the extra field and
  // relies on the cookie as before.
  const token = createSessionToken();
  const res = NextResponse.json({ ok: true, token });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: proto === "https",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
