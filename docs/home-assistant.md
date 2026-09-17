# Home Assistant + presence

Part of the [Smart Assistant](../README.md) project. See
[`docs/event-bus-and-goals.md`](event-bus-and-goals.md) for the service
these presence events feed into.

**2026-08-21 — phone-presence-only, the smallest slice of Home Assistant
that's actually useful here.** A self-hosted Home Assistant container
(`ghcr.io/home-assistant/home-assistant:stable`, `docker-compose.yml`,
bind-mounted `./homeassistant/config:/config`, port `8123` published for
onboarding/companion-app setup) whose only job right now is turning the
Home Assistant companion app's phone-presence zone tracking into events on
`assistant-net` — no smart-home device control, no voice, nothing else
wired up yet.

`configuration.yaml` defines two `rest_command`s
(`notify_event_bus_arrived_home`/`_left_home`) that `POST` to
`event-bus:3004/events` — the same generic ingestion endpoint
`discord-bot`/`coding-orchestrator` already publish through (see
[`docs/event-bus-and-goals.md`](event-bus-and-goals.md)), reached over
`assistant-net` since both containers are on the same compose network.
`automations.yaml` triggers each one off `person.john_abraham`'s state
transitioning to/from `"home"`, publishing
`home_assistant.arrived_home`/`left_home` events. Neither event currently
drives any downstream behavior in `classify.ts`/`goal-matching.ts` — this is
pure ingestion for now, plumbing to build on later (an idle-reflection
signal, an away-mode nudge), not a finished feature.

**Docker Desktop on Windows doesn't support `network_mode: host`** — Home
Assistant's own recommended mode, needed for full mDNS device discovery.
Irrelevant at this scope: the companion app connects via a manually-entered
URL (`http://<host>:8123`), not discovery, so the container just joins
`assistant-net` like everything else.

**Not committed as-is**: `homeassistant/config/` is Home Assistant's real
runtime directory, not just source config — `.storage/` (auth tokens,
device/entity registries), the sqlite `home-assistant_v2.db`, logs, and an
icon cache all live there alongside the actual config files. Only
`configuration.yaml`, `automations.yaml`, `scripts.yaml`, `scenes.yaml`,
`secrets.yaml` (still Home Assistant's own generated placeholder, not a real
secret), and `blueprints/` are tracked — everything else is gitignored.
