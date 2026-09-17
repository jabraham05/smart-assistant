import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHeading } from "./detect-heading.js";

test("detectHeading: finds a numbered section heading", () => {
  assert.equal(detectHeading("4.2 Fuel Injectors\nSome body text follows here."), "4.2 Fuel Injectors");
});

test("detectHeading: finds a top-level numbered heading (no sub-number)", () => {
  assert.equal(detectHeading("4 Fuel System\nBody text."), "4 Fuel System");
});

test("detectHeading: finds a 'number. Title' heading (period, not just a space) - real case from the Bitcoin whitepaper PDF", () => {
  assert.equal(detectHeading("2. Transactions\nWe define an electronic coin as a chain of signatures."), "2. Transactions");
  assert.equal(detectHeading("4. Proof-of-Work\nTo implement a distributed timestamp server."), "4. Proof-of-Work");
});

test("detectHeading: finds an ALL-CAPS heading line", () => {
  assert.equal(detectHeading("FUEL SYSTEM OVERVIEW\nBody text follows."), "FUEL SYSTEM OVERVIEW");
});

test("detectHeading: returns null for ordinary paragraph text with no heading cues", () => {
  assert.equal(detectHeading("This is just a normal sentence describing the fuel pump relay."), null);
});

test("detectHeading: only checks the first few lines, not the whole page", () => {
  const page = ["intro line one", "intro line two", "intro line three", "intro line four", "intro line five", "4.2 Fuel Injectors"].join(
    "\n",
  );
  assert.equal(detectHeading(page), null);
});

test("detectHeading: rejects a heading-shaped line that's too long to plausibly be a heading", () => {
  const longLine = "4.2 " + "A".repeat(90);
  assert.equal(detectHeading(longLine), null);
});

test("detectHeading: blank lines between real lines don't count toward the line-count limit", () => {
  const page = "\n\n\n\n\n4.2 Fuel Injectors";
  assert.equal(detectHeading(page), "4.2 Fuel Injectors");
});
