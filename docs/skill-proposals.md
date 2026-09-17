# Skill proposals (self-authoring, human-gated) — first step toward self-growing skills

Part of the [Smart Assistant](../README.md) project. See
[`docs/skill-gap-scanner.md`](skill-gap-scanner.md) for the autonomous
counterpart to this reactive mechanism, and
[`docs/chat-workflow.md`](chat-workflow.md) for where `Get Active Skills`/
`Format Skills Catalog` fit into the main pipeline.

Generalizes the same "propose, never auto-apply" pattern the old
`propose_persona_change` used (see
[`docs/persona-system.md`](persona-system.md)), applied to a general
skill/capability library instead of just the persona prompt. This is the
**reactive** half of the project's long-term self-growing-skills goal — the
agent proposing something when it hits a gap mid-conversation — not the
larger autonomous background-job vision, which stays deferred.

**Skills and tools are not the same thing** — two different layers of gap,
consumed in completely different ways once approved:
- **`instruction` skill** — plain-text procedure ("how to do X"), no code.
  The agent can fully draft this itself. Once a human flips its `status` to
  `"active"` in the Data Table UI, it's consumed exactly like the peer
  cards ([`docs/honcho-memory.md`](honcho-memory.md)): **injected directly
  into every turn's system prompt** (`Get Active Skills` → `Format Skills
  Catalog`, see [`docs/chat-workflow.md`](chat-workflow.md)'s pipeline
  diagram) — no tool call needed to "load" it, the instructions are just
  already sitting in context. Deliberately avoids a `use_skill` tool-call
  as the activation mechanism, which would reintroduce native tool-calling
  unreliability for something that doesn't need it.
- **`tool_idea` skill** — a request for a genuinely new capability that
  needs real code (a new `skills-mcp` tool). The agent can only describe
  it, not build it — a human has to actually implement and deploy it
  (following the existing `registerTool`/zod/`textResult` pattern other
  tools use) before it's usable. Once that's done, discovery works exactly
  like any other tool already does — no special mechanism, just a
  well-written tool `description`.

Both kinds are proposed through one MCP tool, `skill_propose` (in
`skills-mcp`), which POSTs to a small n8n workflow (`skill_proposal_intake`,
webhook → Code node → Data Table row insert → Respond to Webhook) that
inserts a new row into the `skills` Data Table with `status="proposed"`. A
human reviews proposed rows in the Data Table UI and manually flips
`status` to `"active"` or `"rejected"` — the only thing marking an
`instruction` skill active does is make `Get Active Skills` start including
it; nothing else needs to change.

`skills` Data Table columns: `name` (kebab-case, agent-authored, validated
against Anthropic's [Agent Skills
spec](https://agentskills.io/specification) naming rules — lowercase,
hyphens only, no leading/trailing/consecutive hyphens, ≤64 chars),
`description` (≤1024 chars — the tool's own schema instructs the model to
state both *what* it does and *when* to use it, quoting the spec's
good/poor example contrast directly), `kind` (`instruction`/`tool_idea`),
`instructions` (full body, `instruction` kind only), `tool_idea_details`
(inputs/outputs/why-not-covered, `tool_idea` kind only), `reason` (why this
would help), `status`. n8n's auto `createdAt`/`updatedAt` are used directly;
no separate `proposed_at` column needed.

**Verified working end-to-end**: proposing both kinds through a live chat
turn correctly inserts rows; approving an `instruction` skill (flipping
`status` to `active`) and starting a *fresh* session demonstrably changed
Amy's behavior to follow that skill's specific instructions, with zero tool
calls involved in "loading" it.
