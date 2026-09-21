import { test } from "node:test";
import assert from "node:assert/strict";
import { isWakeEvent } from "./calendar-watch.js";

test("isWakeEvent matches a plain 'Wake Up' event, case-insensitively", () => {
  assert.equal(isWakeEvent("Wake Up"), true);
  assert.equal(isWakeEvent("wake up"), true);
  assert.equal(isWakeEvent("WAKE"), true);
});

test("isWakeEvent matches whole-word 'wake' inside a longer title", () => {
  assert.equal(isWakeEvent("Daily wake-up call"), true);
});

test("isWakeEvent does not match an unrelated event", () => {
  assert.equal(isWakeEvent("Dentist appointment"), false);
  assert.equal(isWakeEvent("Team standup"), false);
});

test("isWakeEvent does not match a word that merely contains 'wake' as a substring", () => {
  assert.equal(isWakeEvent("Awaken your inner potential seminar"), false);
});

test("isWakeEvent handles missing/empty summaries", () => {
  assert.equal(isWakeEvent(null), false);
  assert.equal(isWakeEvent(undefined), false);
  assert.equal(isWakeEvent(""), false);
});
