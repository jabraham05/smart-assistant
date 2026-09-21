import * as chrono from "chrono-node";

// Exists because the model was observed computing relative dates wrong
// (e.g. "this Wednesday" landing on a Tuesday) even with the real current
// date already injected into its system prompt - the same category of
// unreliability calculate.ts's own header comment documents for
// arithmetic. Same fix: never let the model do the computation itself,
// offload it to real code via a tool call.
//
// chrono-node reads a reference Date through its plain (non-UTC) getters
// (getFullYear/getDate/getHours/...), confirmed directly against the real
// library rather than assumed - which are governed by whatever timezone
// the Node process itself happens to be running in, not the user's actual
// home timezone. The technique below sidesteps that entirely: build a
// reference Date via the *local* Date constructor using the target
// timezone's real current wall-clock numbers. Because JS Date's local
// getters always just echo back whatever the local constructor was given
// (construction and retrieval go through the same process-wide offset
// both times), chrono then sees exactly the target timezone's wall clock,
// regardless of what timezone the actual OS/process is configured with.
// The same trick in reverse turns chrono's answer (also read via local
// getters) back into a real ISO instant with the correct UTC offset.

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getWallClock(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

// Offset (in minutes, ISO sign convention: local minus UTC, so US zones
// come out negative) of `timeZone` at the real instant `date`. Verified
// against a known instant/zone pair in date-resolve.test.ts rather than
// trusted blind.
function getOffsetMinutes(date: Date, timeZone: string): number {
  const wc = getWallClock(date, timeZone);
  const asIfUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
  return (asIfUtc - date.getTime()) / 60_000;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes <= 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface ResolvedDate {
  // ISO 8601 with the real, DST-correct offset for `timeZone` at this
  // instant - the exact shape calendar_event's start/end fields require.
  resolved: string;
  weekday: string;
  humanReadable: string;
}

// Returns null if chrono couldn't parse the phrase at all - a genuinely
// unparseable input, not an error, since this is deterministic parsing
// against free-form text.
export function resolveDate(phrase: string, timeZone: string, now: Date = new Date()): ResolvedDate | null {
  const nowWallClock = getWallClock(now, timeZone);
  // Local Date constructor: JS interprets these numbers in whatever
  // timezone the process itself is in, but since chrono reads this same
  // object back through the same local getters, it sees exactly
  // `nowWallClock` regardless - the process's real timezone never
  // actually matters here.
  const referenceForChrono = new Date(
    nowWallClock.year,
    nowWallClock.month - 1,
    nowWallClock.day,
    nowWallClock.hour,
    nowWallClock.minute,
    nowWallClock.second,
  );

  // forwardDate: always resolve into the future - this is exclusively
  // used for scheduling, never for "what date was last Wednesday."
  const parsed = chrono.parseDate(phrase, referenceForChrono, { forwardDate: true });
  if (!parsed) return null;

  const resultWallClock: WallClock = {
    year: parsed.getFullYear(),
    month: parsed.getMonth() + 1,
    day: parsed.getDate(),
    hour: parsed.getHours(),
    minute: parsed.getMinutes(),
    second: parsed.getSeconds(),
  };

  // Approximate the real instant by treating the resolved wall clock as
  // if it were UTC, then look up the target zone's real offset AT that
  // approximate instant - correct except in the vanishingly rare case
  // where the resolved time falls exactly within the couple of minutes
  // spanning a DST transition, an accepted imprecision for a personal
  // calendar tool.
  const approxInstant = Date.UTC(
    resultWallClock.year,
    resultWallClock.month - 1,
    resultWallClock.day,
    resultWallClock.hour,
    resultWallClock.minute,
    resultWallClock.second,
  );
  const offsetMinutes = getOffsetMinutes(new Date(approxInstant), timeZone);

  const weekday = WEEKDAYS[new Date(approxInstant).getUTCDay()];
  const resolved =
    `${resultWallClock.year}-${pad(resultWallClock.month)}-${pad(resultWallClock.day)}` +
    `T${pad(resultWallClock.hour)}:${pad(resultWallClock.minute)}:${pad(resultWallClock.second)}` +
    formatOffset(offsetMinutes);

  const hour12 = resultWallClock.hour % 12 === 0 ? 12 : resultWallClock.hour % 12;
  const ampm = resultWallClock.hour < 12 ? "AM" : "PM";
  const humanReadable =
    `${weekday}, ${MONTHS[resultWallClock.month - 1]} ${resultWallClock.day}, ${resultWallClock.year} ` +
    `at ${hour12}:${pad(resultWallClock.minute)} ${ampm}`;

  return { resolved, weekday, humanReadable };
}
