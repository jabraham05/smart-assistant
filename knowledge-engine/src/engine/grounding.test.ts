import { test } from "node:test";
import assert from "node:assert/strict";
import { isGrounded } from "./grounding.js";

// Real incident that motivated this: a research-agent model recorded a
// plausible-sounding but entirely fictional API name with no real source
// at all - record_finding accepted it verbatim with no check.
test("isGrounded is false when no sourceUrls were given", () => {
  assert.equal(isGrounded("Widget X supports gadget Y", [], new Map()), false);
});

test("isGrounded is false when the cited URL was never actually fetched this session", () => {
  const fetchedPages = new Map<string, string>();
  assert.equal(isGrounded("Widget X supports gadget Y", ["https://example.com/widget"], fetchedPages), false);
});

test("isGrounded is false when the fetched page text doesn't match the claim", () => {
  const fetchedPages = new Map([["https://example.com/widget", "This page is about gardening tips and recipes."]]);
  assert.equal(isGrounded("Widget X supports gadget Y integration", ["https://example.com/widget"], fetchedPages), false);
});

test("isGrounded is true when the fetched page text backs the claim's keywords", () => {
  const fetchedPages = new Map([
    ["https://example.com/widget", "Widget X is a tool that supports gadget Y integration out of the box."],
  ]);
  assert.equal(isGrounded("Widget X supports gadget Y integration", ["https://example.com/widget"], fetchedPages), true);
});

test("isGrounded is true for a claim with no significant keywords (nothing specific to check)", () => {
  const fetchedPages = new Map([["https://example.com/a", "some page text"]]);
  assert.equal(isGrounded("it is", ["https://example.com/a"], fetchedPages), true);
});
