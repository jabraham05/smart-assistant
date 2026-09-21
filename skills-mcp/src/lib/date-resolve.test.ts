import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDate } from "./date-resolve.js";

// Monday, September 21, 2026, 10:00 AM Pacific (real, verified: 2026-09-21
// is genuinely a Monday) - PDT (-07:00) is in effect at this date.
const REF_PACIFIC = new Date(Date.UTC(2026, 8, 21, 17, 0, 0)); // 10:00 PDT
const TZ = "America/Los_Angeles";

test("'this Wednesday at 6pm' resolves to this week's Wednesday, not next Tuesday", () => {
  const r = resolveDate("this Wednesday at 6pm", TZ, REF_PACIFIC);
  assert.ok(r);
  assert.equal(r!.weekday, "Wednesday");
  assert.equal(r!.resolved, "2026-09-23T18:00:00-07:00");
});

test("'next Wednesday' skips this week's Wednesday and lands on the following week's", () => {
  const r = resolveDate("next Wednesday", TZ, REF_PACIFIC);
  assert.ok(r);
  assert.equal(r!.weekday, "Wednesday");
  assert.equal(r!.resolved.slice(0, 10), "2026-09-30");
});

test("'next Friday' also means next week's Friday, not this week's", () => {
  const r = resolveDate("next Friday", TZ, REF_PACIFIC);
  assert.ok(r);
  assert.equal(r!.weekday, "Friday");
  assert.equal(r!.resolved.slice(0, 10), "2026-10-02");
});

test("'tomorrow' is exactly one day later, same time", () => {
  const r = resolveDate("tomorrow", TZ, REF_PACIFIC);
  assert.ok(r);
  assert.equal(r!.resolved, "2026-09-22T10:00:00-07:00");
});

test("'in 3 days' is exactly three days later", () => {
  const r = resolveDate("in 3 days", TZ, REF_PACIFIC);
  assert.ok(r);
  assert.equal(r!.resolved.slice(0, 10), "2026-09-24");
});

test("weekday field always matches the resolved date's real day of week", () => {
  const r = resolveDate("this Wednesday at 6pm", TZ, REF_PACIFIC);
  const actualDay = new Date(`${r!.resolved.slice(0, 10)}T00:00:00Z`).getUTCDay();
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  assert.equal(r!.weekday, names[actualDay]);
});

test("crosses the real DST boundary correctly: before Nov 1 is -07:00, after is -08:00", () => {
  // America/Los_Angeles DST genuinely ends 2026-11-01 - a date landing
  // before it must still carry -07:00, a date landing after it must carry
  // -08:00. Both computed by the same code path, not hardcoded per-case.
  const before = resolveDate("in 5 days", TZ, REF_PACIFIC); // 2026-09-26, still PDT
  const after = resolveDate("in 45 days", TZ, REF_PACIFIC); // 2026-11-05, PST
  assert.ok(before && after);
  assert.equal(before!.resolved.slice(-6), "-07:00");
  assert.equal(after!.resolved.slice(-6), "-08:00");
});

test("humanReadable names the correct weekday explicitly", () => {
  const r = resolveDate("this Wednesday at 6pm", TZ, REF_PACIFIC);
  assert.ok(r!.humanReadable.startsWith("Wednesday, September 23, 2026"));
});

test("an unparseable phrase returns null, not a guess", () => {
  assert.equal(resolveDate("asdkjfhaskjdfh", TZ, REF_PACIFIC), null);
});

test("resolves correctly for a non-US timezone too (not hardcoded to Pacific)", () => {
  // Monday 2026-09-21 17:00 UTC is already Tuesday 2026-09-22 02:00 in
  // Tokyo (UTC+9, no DST) - "tomorrow" from Tokyo's own Tuesday should
  // land on Tokyo's Wednesday, a different calendar day than Pacific's.
  const r = resolveDate("tomorrow", "Asia/Tokyo", REF_PACIFIC);
  assert.ok(r);
  assert.equal(r!.resolved, "2026-09-23T02:00:00+09:00");
});
