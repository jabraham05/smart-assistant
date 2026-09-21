import { test } from "node:test";
import assert from "node:assert/strict";
import { isConfabulatedAction, hasUnfulfilledSearchIntent } from "./safety-net.js";

test("isConfabulatedAction flags a claimed action with no matching tool call", () => {
  assert.equal(
    isConfabulatedAction("I've scheduled that for you.", ["calendar_event"], []),
    true,
  );
});

test("isConfabulatedAction does not flag a real action that was actually called", () => {
  assert.equal(
    isConfabulatedAction("I've scheduled that for you.", ["calendar_event"], ["calendar_event"]),
    false,
  );
});

test("isConfabulatedAction does not flag plain text with no action claim", () => {
  assert.equal(isConfabulatedAction("The weather today is sunny.", ["weather_get"], []), false);
});

test("isConfabulatedAction ignores a claim when no action tool was even bound", () => {
  assert.equal(isConfabulatedAction("I've added that.", ["weather_get"], []), false);
});

test("hasUnfulfilledSearchIntent flags narrated intent with no actual search call", () => {
  assert.equal(
    hasUnfulfilledSearchIntent("Let me search for that real quick.", ["web_search"], []),
    true,
  );
});

test("hasUnfulfilledSearchIntent does not flag when the search tool was actually called", () => {
  assert.equal(
    hasUnfulfilledSearchIntent("Let me search for that.", ["web_search"], ["web_search"]),
    false,
  );
});

test("hasUnfulfilledSearchIntent does not flag ordinary text", () => {
  assert.equal(hasUnfulfilledSearchIntent("Here's the answer directly.", ["web_search"], []), false);
});
