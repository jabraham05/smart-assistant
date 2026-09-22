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
    relevantMemories: ["mentioned a fuel sender issue on the 987"],
  });
  assert.ok(prompt.includes("Possibly relevant things from earlier conversations:"));
  assert.ok(prompt.includes("- mentioned a fuel sender issue on the 987"));
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
  assert.ok(prompt.includes("[#7, waiting_for_user] measure the fuel sender twice"));
  assert.ok(prompt.includes("Relevant to one of the user's ongoing goals"));
  assert.ok(prompt.includes("[#3, active] increase general knowledge via daily news"));
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
