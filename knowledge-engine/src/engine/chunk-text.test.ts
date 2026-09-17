import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "./chunk-text.js";

test("chunkText: short text under target size stays one chunk", () => {
  const chunks = chunkText("Paragraph one.\n\nParagraph two.", 1000);
  assert.deepEqual(chunks, ["Paragraph one.\n\nParagraph two."]);
});

test("chunkText: splits once accumulated paragraphs would exceed target size", () => {
  const a = "a".repeat(600);
  const b = "b".repeat(600);
  const chunks = chunkText(`${a}\n\n${b}`, 1000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], a);
  assert.equal(chunks[1], b);
});

test("chunkText: a single paragraph longer than target size is not split further", () => {
  const long = "x".repeat(1500);
  const chunks = chunkText(long, 1000);
  assert.deepEqual(chunks, [long]);
});

test("chunkText: blank lines and whitespace-only paragraphs are dropped", () => {
  const chunks = chunkText("Para one.\n\n\n\n   \n\nPara two.", 1000);
  assert.deepEqual(chunks, ["Para one.\n\nPara two."]);
});

test("chunkText: empty input produces zero chunks", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n\n   "), []);
});
