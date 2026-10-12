#!/usr/bin/env node
// One-time OAuth bootstrap for Google Calendar + Drive. Replaces the old
// service-account key (its backing Google Cloud project was deleted, and
// a service account couldn't cover Drive access anyway - it only sees
// files explicitly shared with its own robot email, not "the user's own
// Drive"). Same shape as scripts/spotify-auth.mjs - a real user
// authorization (3-legged "Authorization Code" flow) covering both APIs
// in one consent.
//
// Before running: create an OAuth client at
// https://console.cloud.google.com/apis/credentials (type "Desktop app" -
// no redirect URI needs to be pre-registered for that type, Google
// accepts any http://127.0.0.1:<port> loopback redirect), with the
// Calendar and Drive APIs enabled on that project, then:
//   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node scripts/google-auth.mjs

import http from "node:http";

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the environment");
  process.exit(1);
}

const REDIRECT_URI = "http://127.0.0.1:8787/callback";
const SCOPES = ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/drive"];

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("scope", SCOPES.join(" "));
// access_type=offline is what actually gets a refresh_token back, not
// just a short-lived access token. prompt=consent forces Google to issue
// one even on a repeat authorization (Google only returns a refresh_token
// on the FIRST consent for a given client+scope combination otherwise).
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log("Open this URL in a browser and authorize the app with the Google account to connect:\n");
console.log(authUrl.toString());
console.log("\nWaiting for the redirect...");

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, REDIRECT_URI);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const authCode = url.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(error ? `Authorization failed: ${error}. You can close this tab.` : "Authorized — you can close this tab.");
    server.close();
    if (error) reject(new Error(error));
    else resolve(authCode);
  });
  server.listen(8787);
});

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
  }),
});

if (!res.ok) {
  const body = await res.text().catch(() => "");
  throw new Error(`Token exchange failed: ${res.status} ${body}`);
}

const json = await res.json();
if (!json.refresh_token) {
  console.error(
    "\nNo refresh_token came back - this usually means the account already " +
      "authorized this client+scope combination before. Revoke access at " +
      "https://myaccount.google.com/permissions and run this script again.",
  );
  process.exit(1);
}

console.log("\nAuthorized. Add these to your .env:\n");
console.log(`GOOGLE_OAUTH_CLIENT_ID=${clientId}`);
console.log(`GOOGLE_OAUTH_CLIENT_SECRET=${clientSecret}`);
console.log(`GOOGLE_REFRESH_TOKEN=${json.refresh_token}`);
