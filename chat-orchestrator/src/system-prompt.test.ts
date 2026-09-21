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
