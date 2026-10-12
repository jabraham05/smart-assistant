# Amy - native iOS app

SwiftUI client for the same `chat-ui` API the PWA uses (see
`docs/native-ios-app-plan.md`). It never talks to internal services directly.

## Build & run

```bash
brew install xcodegen
cd ios
xcodegen generate          # creates Amy.xcodeproj from project.yml (not committed)
open Amy.xcodeproj         # or build from the command line:
xcodebuild test -project Amy.xcodeproj -scheme Amy -destination 'platform=iOS Simulator,name=iPhone 16'
```

Re-run `xcodegen generate` after adding or removing Swift files. Never edit
the `.xcodeproj` by hand.

## Connecting

The app reaches `chat-ui` over **Tailscale**, from home or anywhere else:
`https://<host>.<tailnet>.ts.net` (the default; changeable on the login
screen or in Settings). It's HTTPS only, with no App Transport Security
exceptions and no local-network permission. Nothing is exposed to the
public internet.

One-time setup:
1. Install Tailscale on the server host and the iPhone, signed in to the same
   account. On the iPhone, turn on **VPN On Demand** so it reconnects by itself.
2. In the admin console's DNS page, turn on **MagicDNS** and **HTTPS Certificates**.
3. On the host, run `tailscale serve --bg 3000` to put `chat-ui` behind a real
   `*.ts.net` certificate. This persists across reboots.

## Layout

| Path | What |
|---|---|
| `Amy/Networking` | `APIClient` (bearer auth, connect retries, decode diagnostics), Keychain token store, NDJSON stream splitter |
| `Amy/Chat` | The single long-lived thread (`amy-main`), stream reducer (port of `chat-ui/src/lib/message-reducer.ts`) |
| `Amy/Home` | Dashboard: approvals, todos, goals, calendar, activity, task detail |
| `Amy/Settings` | Appearance, server URL, read-only past conversations, log out |
| `AmyTests` | Swift Testing suite for the stream parser and reducer |

## Product decisions

- Chat is one continuous thread with Amy, not a list of chats. Older
  per-session chats (web, Discord, CLI) are read-only under
  Settings → Past conversations.
- Everything else lives behind the slide-out menu.
- Voice (next milestone) is push-to-talk only. There's no always-on listening.
