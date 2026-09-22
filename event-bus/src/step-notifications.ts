import type { TaskContextStepRow } from "./db.js";

// Phase 6b's real per-step narration filter, kept as a pure function
// (no I/O) for direct unit testing - see step-notifications.test.ts.
// Deliberately narrow: failed/blocked always notify (the user needs to
// know something's stuck), completed only notifies once the *whole
// task* is done (every step completed or skipped), not on each
// individual step - notifying on every "running"/intermediate
// completion would just be noise for a multi-step plan the user isn't
// actively watching.
export function stepTransitionNotification(
  step: Pick<TaskContextStepRow, "status" | "description">,
  allSteps: Pick<TaskContextStepRow, "status">[],
  objective: string,
): string | null {
  if (step.status === "failed" || step.status === "blocked") {
    return `Heads up - a step in "${objective}" is ${step.status}: "${step.description}".`;
  }
  if (step.status === "completed") {
    const stillPending = allSteps.some((s) => s.status !== "completed" && s.status !== "skipped");
    if (!stillPending) return `Finished "${objective}" - every step is done.`;
  }
  return null;
}
