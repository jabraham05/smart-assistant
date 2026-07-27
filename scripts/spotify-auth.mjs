#!/usr/bin/env node
// One-time OAuth bootstrap for Spotify playback control. Spotify has no
// service-account equivalent (unlike Google Calendar) - playback control
// acts on a specific person's account, so a real user authorization
// (3-legged "Authorization Code" flow) is unavoidable. This only needs to
// run once (refresh tokens last ~6 months from issuance; re-run this if
// it's been unused that long).
//
// Before running: register an app at https://developer.spotify.com/dashboard,
// add http://127.0.0.1:8888/callback as a Redirect URI in that app's
// settings (Spotify rejects the auth request otherwise), then:
//   SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... node scripts/spotify-auth.mjs

import http from "node:http";

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the environment");
  process.exit(1);
}

const REDIRECT_URI = "http://127.0.0.1:8888/callback";
const SCOPES = ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing"];

const authUrl = new URL("https://accounts.spotify.com/authorize");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("scope", SCOPES.join(" "));

console.log("Open this URL in a browser and authorize the app:\n");
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
  server.listen(8888);
});

const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
const res = await fetch("https://accounts.spotify.com/api/token", {
  method: "POST",
  headers: {
    Authorization: `Basic ${basicAuth}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  }),
});

if (!res.ok) {
  const body = await res.text().catch(() => "");
  throw new Error(`Token exchange failed: ${res.status} ${body}`);
}

const json = await res.json();
console.log("\nAuthorized. Add this to your .env:\n");
console.log(`SPOTIFY_REFRESH_TOKEN=${json.refresh_token}`);
