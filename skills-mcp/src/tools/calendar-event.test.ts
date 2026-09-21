import { test } from "node:test";
import assert from "node:assert/strict";
import { weekdayMismatchError } from "./calendar-event.js";
// Importing calendar-event.js (above) already registers its verifier as a
// module-load side effect - verifyToolResult is the real entry point the
// tool's own handler calls, same as a live request would.
import { verifyToolResult } from "../lib/verify-tool-result.js";

test("catches the exact real bug: title says Wednesday, date is actually Tuesday", () => {
  const err = weekdayMismatchError("Resident Evil Wednesday", "2026-09-22T18:00:00-07:00");
  assert.ok(err);
  assert.match(err!, /says wednesday/i);
  assert.match(err!, /actually a Tuesday/);
});

test("passes when the title's weekday genuinely matches the date", () => {
  assert.equal(weekdayMismatchError("Resident Evil Wednesday", "2026-09-23T18:00:00-07:00"), null);
});

test("does nothing when the title names no weekday at all", () => {
  assert.equal(weekdayMismatchError("Dentist appointment", "2026-09-22T18:00:00-07:00"), null);
});

test("does nothing when there's no title yet (update with only a date change)", () => {
  assert.equal(weekdayMismatchError(undefined, "2026-09-22T18:00:00-07:00"), null);
});

test("is case-insensitive and matches a whole word only", () => {
  // "wednesdays" (plural) must not false-positive-match "wednesday" as a
  // substring and then silently pass a real mismatch.
  const err = weekdayMismatchError("Weekly wednesdays hangout", "2026-09-22T18:00:00-07:00");
  assert.equal(err, null);
});

test("correct across a timezone offset that shifts the calendar date near midnight", () => {
  // 2026-09-23T23:30:00-07:00 is still calendar-day the 23rd (Wednesday)
  // in its own stated offset, regardless of what UTC instant it maps to.
  assert.equal(weekdayMismatchError("Late Wednesday call", "2026-09-23T23:30:00-07:00"), null);
});

test("calendar_event verifier passes a create result that matches the request", () => {
  const result = verifyToolResult(
    "calendar_event",
    { action: "create", summary: "Dentist", start: "2026-09-22T18:00:00-07:00", end: "2026-09-22T19:00:00-07:00" },
    { id: "abc123", summary: "Dentist", start: { dateTime: "2026-09-22T18:00:00-07:00" }, end: { dateTime: "2026-09-22T19:00:00-07:00" } },
  );
  assert.deepEqual(result, { ok: true });
});

test("calendar_event verifier flags a summary mismatch from Google", () => {
  const result = verifyToolResult(
    "calendar_event",
    { action: "create", summary: "Dentist" },
    { id: "abc123", summary: "Dentits" },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /Dentist.*Dentits/);
});

test("calendar_event verifier flags a missing event id", () => {
  const result = verifyToolResult("calendar_event", { action: "create", summary: "Dentist" }, { summary: "Dentist" });
  assert.equal(result.ok, false);
});

test("calendar_event verifier flags a start-time mismatch from Google", () => {
  const result = verifyToolResult(
    "calendar_event",
    { action: "create", start: "2026-09-22T18:00:00-07:00" },
    { id: "abc123", start: { dateTime: "2026-09-23T18:00:00-07:00" } },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /start/);
});

test("calendar_event verifier is a no-op for list/delete actions", () => {
  assert.deepEqual(verifyToolResult("calendar_event", { action: "list" }, {}), { ok: true });
  assert.deepEqual(verifyToolResult("calendar_event", { action: "delete" }, {}), { ok: true });
});
