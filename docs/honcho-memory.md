# Honcho peer cards (proactive memory + behavioral instructions for Amy)

Part of the [Smart Assistant](../README.md) project. See
[`docs/chat-workflow.md`](chat-workflow.md) for the pipeline this fits into
and [`docs/persona-system.md`](persona-system.md) for how the resulting
system prompt is assembled.

Beyond the reactive `memory_recall` tool (which only fires when the LLM
decides to call it — unreliable, see
[`docs/chat-workflow.md`](chat-workflow.md)'s tool-calling gotcha), the
`Chat` workflow now injects two Honcho **peer cards** directly into Amy's
system prompt every turn, via plain HTTP Request nodes (`Get User Card`,
`Get User Card For Amy`) — no tool-calling involved, so it can't be skipped:

- **`user`'s own card** — durable facts about the user (name, age,
  education, job search status, etc). This is Honcho's default
  self-representation of peer `user`.
- **`user`'s directional card *for* `amy`** (`target=amy`) — standing
  instructions/goals for how Amy should behave, from the user's
  perspective (e.g. "GOAL: assist the user with everything possible",
  "TRAIT: butler-type personality"). This requires `observe_others: true`
  to be set for peer `user` on the session (the `Set User Observe Config`
  node does this, idempotently, every turn) — without it, Honcho has no
  directional `(observer=user, observed=amy)` representation to draw a
  card from. `Ensure Session Exists` (a `POST .../sessions` get-or-create
  call) runs immediately before this and is required: Honcho sessions are
  otherwise only created lazily by the message-store call at the *end* of
  the turn, so without it, the very first turn of any new session would 404
  on the config PUT (session doesn't exist yet) and silently skip setting
  `observe_others` for that session's whole lifetime. See Honcho's
  [representation scopes
  docs](../honcho-src/docs/v3/documentation/features/advanced/representation-scopes.mdx)
  for the observer/observed model this relies on.

Both cards start out populated from a one-time manual bootstrap
(`node scripts/set-peer-cards.mjs`, requires `HONCHO_API_KEY` in the
environment) rather than waiting for Honcho's automatic "dreaming"
consolidation (which only runs after a threshold of new conclusions + an
idle period — see Honcho's dreaming docs). From here, dreaming should keep
both cards updated as real conversations accumulate; `set-peer-cards.mjs`
is safe to re-run (it replaces the whole card, doesn't merge) if you want
to hand-correct something.

We deliberately did **not** add a third card — Amy's directional view of
`user` (`observer=amy, observed=user`) — since Amy is present in literally
every session with the user, so that representation would reason over the
exact same messages as `user`'s own self-card, doubling Honcho's background
reasoning cost for no real gain. Revisit if a second persona/agent that
*doesn't* sit in every session is ever added.

Both HTTP nodes have `onError: continueRegularOutput` set — if Honcho is
briefly unreachable, or a card is empty/not-yet-created, the expression that
builds Amy's system prompt falls back to just the base persona text rather
than breaking the chat.
