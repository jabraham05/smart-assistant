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

The server URL defaults to the LAN test container and can be changed on the
login screen or in Settings. Plain HTTP is allowed for local-network
addresses only (`NSAllowsLocalNetworking`).

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
