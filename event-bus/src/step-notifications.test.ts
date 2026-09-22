import { test } from "node:test";
import assert from "node:assert/strict";
import { stepTransitionNotification } from "./step-notifications.js";

test("stepTransitionNotification notifies immediately on failed", () => {
  const step = { status: "failed", description: "Book flights" };
  const msg = stepTransitionNotification(step, [step], "Plan Japan trip");
  assert.match(msg ?? "", /Book flights/);
  assert.match(msg ?? "", /failed/);
});

test("stepTransitionNotification notifies immediately on blocked", () => {
  const step = { status: "blocked", description: "Book flights" };
  const msg = stepTransitionNotification(step, [step], "Plan Japan trip");
  assert.match(msg ?? "", /blocked/);
});

test("stepTransitionNotification does not notify on a mid-plan completed step when others are still pending", () => {
  const completed = { status: "completed", description: "Book flights" };
  const pending = { status: "pending", description: "Book hotels" };
  const msg = stepTransitionNotification(completed, [completed, pending], "Plan Japan trip");
  assert.equal(msg, null);
});

test("stepTransitionNotification notifies once the final step completes", () => {
  const completed1 = { status: "completed", description: "Book flights" };
  const completed2 = { status: "completed", description: "Book hotels" };
  const msg = stepTransitionNotification(completed2, [completed1, completed2], "Plan Japan trip");
  assert.match(msg ?? "", /Finished "Plan Japan trip"/);
});

test("stepTransitionNotification treats skipped steps as done for the final-completion check", () => {
  const skipped = { status: "skipped", description: "Optional step" };
  const completed = { status: "completed", description: "Book flights" };
  const msg = stepTransitionNotification(completed, [skipped, completed], "Plan Japan trip");
  assert.match(msg ?? "", /Finished/);
});

test("stepTransitionNotification does not notify on pending/running transitions", () => {
  assert.equal(stepTransitionNotification({ status: "pending", description: "x" }, [], "Task"), null);
  assert.equal(stepTransitionNotification({ status: "running", description: "x" }, [], "Task"), null);
});
