# chat-ui

A Next.js web chat client for the Smart Assistant stack — a custom UI
alternative to n8n's own test-chat widget, wired into the project's root
`docker-compose.yml` (builds from `Dockerfile`, serves on `:3000`).

- `src/app/api/chat` — proxies chat messages through to the n8n Chat
  Trigger webhook (`N8N_WEBHOOK_URL`).
- `src/app/api/sessions` — reads session list/history from Honcho
  (`HONCHO_API_KEY`, `HONCHO_WORKSPACE_ID`) via `src/lib/honcho-client.ts`.
- `src/lib/n8n-client.ts` — talks to the n8n webhook.
- `src/lib/step-classifier.ts` — classifies streamed agent steps for
  display.

## Local dev

```bash
cp .env.local.example .env.local   # fill in N8N_WEBHOOK_URL / HONCHO_API_KEY
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). See the root
`README.md` for the rest of the stack (n8n, Ollama, Honcho, postgres) this
depends on.
