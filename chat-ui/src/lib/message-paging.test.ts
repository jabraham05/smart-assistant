import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessagePage } from "./message-paging";

test("no paging params keeps the legacy unpaged behavior", () => {
  assert.equal(parseMessagePage(new URLSearchParams("")), null);
});

test("parses size and page", () => {
  assert.deepEqual(parseMessagePage(new URLSearchParams("size=30&page=2")), { size: 30, page: 2 });
});

test("clamps size to Honcho's hard max and page to at least 1", () => {
  assert.deepEqual(parseMessagePage(new URLSearchParams("size=500&page=0")), { size: 100, page: 1 });
});

test("garbage values fall back to defaults", () => {
  assert.deepEqual(parseMessagePage(new URLSearchParams("size=abc&page=xyz")), { size: 50, page: 1 });
});
