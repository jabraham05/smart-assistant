import { test } from "node:test";
import assert from "node:assert/strict";
import { matchKeywords } from "./goal-matching.js";

test("matchKeywords: matches a keyword found in the event type", () => {
  const goal = { keywords: ["muscle", "weight loss"] };
  const event = { type: "discord.dm_received", source: "discord", payload: { text: "hit a new muscle PR today" } };
  assert.deepEqual(matchKeywords(goal, event), ["muscle"]);
});

test("matchKeywords: matches are case-insensitive on both sides", () => {
  const goal = { keywords: ["Job Search"] };
  const event = { type: "discord.dm_received", source: "discord", payload: { text: "update on my JOB SEARCH" } };
  assert.deepEqual(matchKeywords(goal, event), ["Job Search"]);
});

test("matchKeywords: returns every matching keyword, not just the first", () => {
  const goal = { keywords: ["muscle", "weight loss", "unrelated"] };
  const event = { type: "discord.dm_received", source: "discord", payload: { text: "muscle gains and weight loss progress" } };
  assert.deepEqual(matchKeywords(goal, event), ["muscle", "weight loss"]);
});

test("matchKeywords: returns an empty array when nothing matches", () => {
  const goal = { keywords: ["muscle", "weight loss"] };
  const event = { type: "discord.dm_received", source: "discord", payload: { text: "what's the weather like" } };
  assert.deepEqual(matchKeywords(goal, event), []);
});

test("matchKeywords: is plain substring containment, not word-boundary matching", () => {
  const goal = { keywords: ["cat"] };
  const event = { type: "discord.dm_received", source: "discord", payload: { text: "the category was wrong" } };
  // Documents the real, accepted v1 gap: "cat" matches inside "category".
  assert.deepEqual(matchKeywords(goal, event), ["cat"]);
});

test("matchKeywords: empty-string keywords are filtered out, never treated as a universal match", () => {
  const goal = { keywords: ["", "muscle"] };
  const event = { type: "discord.dm_received", source: "discord", payload: { text: "anything at all" } };
  assert.deepEqual(matchKeywords(goal, event), []);
});

test("matchKeywords: a goal with no keywords never matches", () => {
  const goal = { keywords: [] };
  const event = { type: "discord.dm_received", source: "discord", payload: { text: "muscle weight loss job search" } };
  assert.deepEqual(matchKeywords(goal, event), []);
});

test("matchKeywords: source and type are searched too, not just the payload", () => {
  const goal = { keywords: ["home_assistant"] };
  const event = { type: "arrived_home", source: "home_assistant", payload: {} };
  assert.deepEqual(matchKeywords(goal, event), ["home_assistant"]);
});
