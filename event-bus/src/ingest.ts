import type { Config } from "./config.js";
import * as db from "./db.js";
import { classify } from "./classify.js";
import { matchEventToGoals } from "./goal-matching.js";
import { notifySession } from "./notify.js";
import { notifyOwnerDirect } from "./discord-notify.js";
import { buildEventMessage } from "./message-templates.js";

// Extracted from POST /events so other in-process producers (calendar-watch.ts,
// and eventually the idle-reflection routes) can run the exact same
// classify -> goal-match -> escalate pipeline without a self-HTTP loopback.
export async function ingestEvent(config: Config, input: db.InsertEventInput): Promise<db.EventRow> {
  const event = await db.insertEvent(config, input);

  const { priority, notify } = classify(event.source, event.type);
  await db.updateEventClassification(config, event.id, { priority, should_notify: notify });

  await matchEventToGoals(config, event);

  if (notify && event.origin_session_id) {
    await notifySession(config, event.origin_session_id, buildEventMessage(event));
    await db.markEventStatus(config, event.id, "notified", true);
  } else if (notify) {
    await db.markEventStatus(config, event.id, "notify_skipped_no_session");
  } else if (priority === "high" && !event.origin_session_id) {
    // Orphaned high-priority event: no session to reply into, and (per
    // classify.ts) no source-level notification already covers it either
    // (that's what notify:false means for these rules - the source
    // handles the has-session case itself). Escalate via a direct DM
    // instead of dropping it.
    await notifyOwnerDirect(config, buildEventMessage(event));
    await db.markEventStatus(config, event.id, "notified", true);
  } else {
    await db.markEventStatus(config, event.id, "processed");
  }

  return event;
}
