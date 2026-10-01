import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./system-prompt.js";

test("buildSystemPrompt omits empty sections", () => {
  const prompt = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
  });
  assert.ok(prompt.startsWith("You are Amy."));
  assert.ok(prompt.includes("Pacific time"));
  assert.ok(!prompt.includes("What you know about the user"));
  assert.ok(!prompt.includes("Standing instructions"));
  assert.ok(!prompt.includes("Skills you have learned"));
});

test("buildSystemPrompt always includes the action-clarify line", () => {
  const prompt = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
  });
  assert.ok(prompt.includes("never invent a specific technology, API, SDK, or product name"));
  assert.ok(prompt.includes("ask the user which one they want before calling the tool"));
});

test("buildSystemPrompt always includes the tone line, last", () => {
  const prompt = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
  });
  assert.ok(prompt.includes("Close naturally"));
  assert.ok(prompt.includes("No emoji."));
  assert.ok(prompt.includes("Bad (too long"));
  assert.ok(prompt.includes("Bad (icon-decorated list"));
  assert.ok(prompt.trimEnd().endsWith("the bad ones'."));
});

test("buildSystemPrompt includes every section when populated", () => {
  const prompt = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: ["likes coffee", "works remotely"],
    userCardForAmy: ["be concise"],
    skillsCatalogText: "## a-skill\ndesc\n\ninstructions",
  });
  assert.ok(prompt.includes("What you know about the user: likes coffee; works remotely"));
  assert.ok(prompt.includes("Standing instructions from the user about how you should behave: be concise"));
  assert.ok(prompt.includes("Skills you have learned:\n\n## a-skill"));
});

test("buildSystemPrompt omits relevantMemories when absent or empty", () => {
  const prompt = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
    relevantMemories: [],
  });
  assert.ok(!prompt.includes("Possibly relevant things from earlier conversations"));
});

test("buildSystemPrompt includes relevantMemories when populated", () => {
  const prompt = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
    relevantMemories: [{ content: "mentioned a fuel sender issue on the 987", grounding: "user_stated" }],
  });
  assert.ok(prompt.includes("Possibly relevant things from earlier conversations:"));
  assert.ok(prompt.includes("- mentioned a fuel sender issue on the 987"));
});

// Real incident that motivated this: an invented, plausible-sounding API
// name written with zero tool calls got stored into memory, then retrieved
// and cited as "confirmed research" in a later, unrelated conversation. An
// ungrounded memory must render with an explicit unverified caveat so the
// model doesn't repeat it as settled fact.
test("buildSystemPrompt renders an ungrounded memory with an unverified caveat", () => {
  const prompt = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
    relevantMemories: [{ content: "Qwen3.8-LiveTranslate API supports WebRTC", grounding: "ungrounded" }],
  });
  assert.ok(prompt.includes("[unverified"));
  assert.ok(prompt.includes("Qwen3.8-LiveTranslate API supports WebRTC"));
});

test("buildSystemPrompt renders tool_verified and user_stated memories without a caveat", () => {
  const prompt = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
    relevantMemories: [
      { content: "checked the calendar and found a conflict", grounding: "tool_verified" },
      { content: "said they prefer mornings", grounding: "user_stated" },
    ],
  });
  assert.ok(!prompt.includes("[unverified"));
  assert.ok(prompt.includes("- checked the calendar and found a conflict"));
  assert.ok(prompt.includes("- said they prefer mornings"));
});

test("buildSystemPrompt includes open tasks and relevant goals when present", () => {
  const prompt = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
    openTasks: [{ id: 7, objective: "measure the fuel sender twice", status: "waiting_for_user" }],
    relevantGoals: [{ id: 3, title: "increase general knowledge via daily news", status: "active" }],
  });
  assert.ok(prompt.includes("Open tasks you're tracking across conversations"));
  assert.ok(prompt.includes("[task #7, waiting_for_user] measure the fuel sender twice"));
  assert.ok(prompt.includes("Relevant to one of the user's ongoing goals"));
  assert.ok(prompt.includes("[goal #3, active] increase general knowledge via daily news"));
});

test("buildSystemPrompt omits open tasks/goals sections when empty", () => {
  const prompt = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
    openTasks: [],
    relevantGoals: [],
  });
  assert.ok(!prompt.includes("Open tasks you're tracking"));
  assert.ok(!prompt.includes("Relevant to one of the user's ongoing goals"));
});

test("buildSystemPrompt includes the needsPlanning nudge only when set", () => {
  const withNudge = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
    needsPlanningNudge: true,
  });
  assert.ok(withNudge.includes("action='plan'"));

  const without = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
  });
  assert.ok(!without.includes("action='plan'"));
});

test("buildSystemPrompt includes the narrate-before-slow-answer nudge only when set", () => {
  const withNudge = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
    narrateBeforeSlowAnswer: true,
  });
  assert.ok(withNudge.includes("briefly say what you're"));

  const without = buildSystemPrompt({
    personaSystemPrompt: "You are Amy.",
    now: new Date("2026-09-21T12:00:00Z"),
    userCard: [],
    userCardForAmy: [],
    skillsCatalogText: "",
  });
  assert.ok(!without.includes("briefly say what you're"));
});
