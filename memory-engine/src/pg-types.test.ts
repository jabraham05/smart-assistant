import { test } from "node:test";
import assert from "node:assert/strict";
import { types } from "pg";
import { INT8_OID, parseInt8 } from "./pg-types.js";

test("BIGINT ids and counts parse as numbers", () => {
  assert.equal(parseInt8("12"), 12);
  assert.equal(parseInt8("0"), 0);
  assert.equal(parseInt8("-3"), -3);
});

test("values past 2^53 fail loudly instead of rounding", () => {
  assert.throws(() => parseInt8("9007199254740993"), /safe integer range/);
});

test("importing the module registers the parser with pg", () => {
  assert.equal(types.getTypeParser(INT8_OID, "text"), parseInt8);
});
