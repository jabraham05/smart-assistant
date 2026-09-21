// Ported verbatim from the n8n Chat workflow's AI Agent.systemMessage
// expression: persona text + Pacific-time date injection + user card +
// user-for-amy card + skills catalog, each clause degrading to an empty
// string if its source is missing.
export function buildSystemPrompt(input: {
  personaSystemPrompt: string;
  now: Date;
  userCard: string[];
  userCardForAmy: string[];
  skillsCatalogText: string;
}): string {
  const dateLine = `Right now it is ${formatPacific(input.now)} (Pacific time) — use this as ground truth for any relative date/time the user mentions (today, tomorrow, next week, etc.) when creating or checking calendar events. Never guess a date or fall back to a placeholder.`;

  const userCardLine = input.userCard.length
    ? `What you know about the user: ${input.userCard.join("; ")}`
    : "";

  const userCardForAmyLine = input.userCardForAmy.length
    ? `Standing instructions from the user about how you should behave: ${input.userCardForAmy.join("; ")}`
    : "";

  const skillsLine = input.skillsCatalogText ? `Skills you have learned:\n\n${input.skillsCatalogText}` : "";

  return [input.personaSystemPrompt, dateLine, userCardLine, userCardForAmyLine, skillsLine]
    .filter(Boolean)
    .join("\n\n");
}

function formatPacific(date: Date): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  // Intl gives "Monday, September 21, 2026 at 2:30 PM" style output on
  // recent Node - format() with these options already includes "at"
  // wording on V8, but normalize just in case a runtime formats it as
  // "Monday, September 21, 2026, 2:30 PM" instead.
  return formatted.includes(" at ") ? formatted : formatted.replace(/, (\d)/, " at $1");
}
