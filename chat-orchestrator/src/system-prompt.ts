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
  // Pre-filtered by the caller based on memoryPolicy (see index.ts) -
  // this function stays policy-agnostic, same as every other section
  // here: given something, render it; given nothing, omit the section
  // entirely. Distinct from userCard (a general evolving profile) - these
  // are specific past turns relevant to *this* message, from
  // memory-engine's automatic cross-conversation retrieval.
  relevantMemories?: string[];
  // Injected regardless of memoryPolicy (directly actionable state, not
  // ambient personalization - see the architecture plan's context-
  // assembly pipeline), but lexeme-matched to the current message
  // (matchTaskContexts) rather than every open task every turn - real bug
  // found via live dogfooding: unconditionally showing every open task
  // context in every conversation let one standing personal reminder
  // bleed into and get conflated with completely unrelated topics. Same
  // relevance-scoping reasoning as relevantGoals below.
  openTasks?: { id: number; objective: string; status: string }[];
  // Keyword-matched to the current message (event-bus's deterministic
  // matcher) - only genuinely relevant goals, not every open goal every
  // turn. Same always-on-regardless-of-memoryPolicy reasoning as openTasks.
  relevantGoals?: { id: number; title: string; status: string }[];
  // Set when needsPlanning=true and no open task context already exists
  // for this thread - a one-time nudge to call
  // task_context_manage(action='create') then action='plan' before
  // attempting the task, since the content of a plan is a judgment call
  // the classifier can't make itself.
  needsPlanningNudge?: boolean;
  // Phase 6a - prompt-only, no extra LLM call (the model already
  // generates one response per turn; this just shapes what that same
  // generation includes). Set for turns likely to take a while
  // (needsPlanning, background, or a research/web capability classified)
  // so the user isn't staring at silence with no idea something's
  // happening.
  narrateBeforeSlowAnswer?: boolean;
}): string {
  const dateLine = `Right now it is ${formatPacific(input.now)} (Pacific time) — use this as ground truth for any relative date/time the user mentions (today, tomorrow, next week, etc.) when creating or checking calendar events. Never guess a date or fall back to a placeholder.`;

  // Real gap found via live testing: a tool result full of structured
  // findings (e.g. research_task_status) got pasted back nearly verbatim
  // as a long, unstructured wall of text - technically complete, not
  // actually useful. This is a standing response-style rule, not
  // conditional on anything this turn, since the underlying problem
  // (dumping raw tool output instead of synthesizing it) can happen with
  // any tool, not just research.
  const responseStyleLine =
    "Default to concise: lead with the 2-3 most important points in your own words, not a raw dump " +
    "of everything a tool returned. Consolidate related information rather than listing it item by " +
    "item. Only go into full detail when the user actually asks for more/an explanation - and even " +
    "then, organize and summarize rather than pasting raw data. If a tool result includes a " +
    "documentUrl (or similar link to fuller detail), mention it so the user can read more if they " +
    "want to, instead of trying to fit everything into the chat reply itself.";

  // Real gap found via live testing: agentMaxIterations already leaves
  // plenty of room to retry a failed tool call within the same reply, but
  // the model would just narrate "I'll check again" or "let me try that
  // later" and stop, leaving the user to manually nudge it forward. A
  // deterministic backstop retries with the actual error text (see
  // index.ts's tool-error retry loop) - this is the prompt half, since
  // most cases should be resolved by the model itself well before that
  // backstop ever needs to fire.
  const toolErrorLine =
    "If a tool call returns an error, don't just tell the user you'll check again later - diagnose " +
    "what went wrong, make the minimal necessary change, and call it again yourself right now, in " +
    "this same reply, before answering.";

  // Real, live-verified finding (ported to agent-service/src/system_prompt.py
  // first - see its matching comment): asked to retry a coding task, the
  // model wrote code_task's own description itself and invented a specific,
  // plausible-sounding but entirely fictional API name ("Qwen3.8-
  // LiveTranslate API") and a technology the real implementation never used
  // (WebRTC) - neither came from the user, neither came from any tool
  // result, both just sounded right. This has to be prompted against before
  // the call, since there is no tool result yet to check it against.
  const actionClarifyLine =
    "When calling code_task, skill_propose, or project_propose, describe the task in your own " +
    "words with real, concrete planning detail - don't just restate the user's wording verbatim. " +
    "But never invent a specific technology, API, SDK, or product name you aren't actually sure " +
    "is real. If you're not sure which service, library, or approach fits a key part of the task, " +
    "or a meaningful technical detail is genuinely ambiguous, ask the user which one they want " +
    "before calling the tool - don't guess a plausible-sounding name and write it in as if it were " +
    "settled. If a similar task already has real, relevant work in the target repo, say so and " +
    "ask whether to build on it before describing a conflicting fresh approach.";

  const userCardLine = input.userCard.length
    ? `What you know about the user: ${input.userCard.join("; ")}`
    : "";

  const userCardForAmyLine = input.userCardForAmy.length
    ? `Standing instructions from the user about how you should behave: ${input.userCardForAmy.join("; ")}`
    : "";

  const relevantMemoriesLine = input.relevantMemories?.length
    ? `Possibly relevant things from earlier conversations:\n${input.relevantMemories.map((m) => `- ${m}`).join("\n")}`
    : "";

  // "task #N" / "goal #N", not a bare "#N" - real bug found via live
  // dogfooding: ids collide across tables (a goal and a project and a
  // task context can all be "#8"), and the model conflated them when the
  // system prompt's own listing didn't disambiguate, even after tool
  // results elsewhere were fixed to say "task #N"/"goal #N" explicitly.
  const openTasksLine = input.openTasks?.length
    ? `Open tasks you're tracking across conversations, relevant to this message (use task_context_manage to check in on or advance one):\n${input.openTasks
        .map((t) => `- [task #${t.id}, ${t.status}] ${t.objective}`)
        .join("\n")}`
    : "";

  const relevantGoalsLine = input.relevantGoals?.length
    ? `Relevant to one of the user's ongoing goals:\n${input.relevantGoals.map((g) => `- [goal #${g.id}, ${g.status}] ${g.title}`).join("\n")}`
    : "";

  const needsPlanningLine = input.needsPlanningNudge
    ? "This looks like a multi-step task. Before working on it, call task_context_manage with " +
      "action='create' (if you haven't already tracked this), then action='plan' with an ordered " +
      "list of concrete steps - then use action='advance_step' as each one actually completes."
    : "";

  const narrateLine = input.narrateBeforeSlowAnswer
    ? "This will likely take a moment (multiple steps or a real lookup) - briefly say what you're " +
      "about to do before doing it (e.g. \"I'll check your calendar first...\"), so it's clear " +
      "something's happening rather than leaving the user waiting with no context."
    : "";

  const skillsLine = input.skillsCatalogText ? `Skills you have learned:\n\n${input.skillsCatalogText}` : "";

  // Placed last, right before the user's actual message - see
  // agent-service/src/system_prompt.py's matching comment: a real,
  // live-verified finding that qwen3:8b still produced stock-offer closers
  // and emoji despite the persona's own "How you talk" section already
  // forbidding it - a small local model's instruction-following is
  // recency-biased, so the same rule repeated here, closest to generation,
  // is where it actually sticks.
  const toneLine =
    "Close naturally: only ask a follow-up when something specific actually depends on the " +
    "answer, and never end with a stock offer like \"let me know if you need anything\" or " +
    "\"no pressure, I'm here when you're ready\" - if there's nothing left to ask, just stop. " +
    "No emoji.\n\n" +
    "Example - user says \"never mind, I'll deal with this later, heading out now\":\n" +
    "Bad (too long, stock closer, emoji): \"No problem at all! Travel safe, and whenever you're " +
    "ready to pick this back up just let me know - I'm here to help whenever you need it! \u{1F697}\"\n" +
    "Good (what you should actually write): \"Sounds good, it'll be here when you're back.\"\n\n" +
    "Example - user asks for the weather:\n" +
    "Bad (icon-decorated list, stock closer): \"\u{1F321}️ Temperature: 62°F, feels " +
    "like 60°F ☀️ Clear sky \u{1F4A7} Humidity: 80% \n\nLet me know if you want " +
    "the hourly forecast!\"\n" +
    "Good (what you should actually write): \"62°F and clear right now, feels like 60.\"\n\n" +
    "This applies to any structured info you report (weather, calendar, search results) - plain " +
    "sentences, not icon-decorated lists, no emoji, and no offer to keep helping unless asked. " +
    "Match the good examples' length and plainness, not the bad ones'.";

  return [
    input.personaSystemPrompt,
    dateLine,
    responseStyleLine,
    toolErrorLine,
    actionClarifyLine,
    userCardLine,
    userCardForAmyLine,
    relevantMemoriesLine,
    openTasksLine,
    relevantGoalsLine,
    needsPlanningLine,
    narrateLine,
    skillsLine,
    toneLine,
  ]
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
