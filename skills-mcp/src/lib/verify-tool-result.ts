// Generalizes the pattern calendar-event.ts already partially demonstrates
// (implausibleDateError catches bad input before the call; this catches a
// bad *result* after it) into an explicit, reusable, per-tool registry.
// "No second LLM call is required" - code can verify success/required
// fields/requested values match without asking the model to double-check
// its own work. Deliberately NOT a generic middleware wrapper - each
// verifier lives here but is called from inside its own tool's handler,
// right before that handler decides what to return, matching this
// codebase's existing convention that validation lives with the tool
// that knows its own success shape (implausibleDateError, maxResults
// coercion, etc. all live inside calendar-event.ts itself, not shared).

export interface VerificationResult {
  ok: boolean;
  reason?: string;
}

// Deliberately untyped `args`/`result` - each verifier below narrows to
// exactly the shape its own tool actually produces; a shared type here
// would just be `unknown` in practice.
export type ToolVerifier = (args: Record<string, unknown>, result: unknown) => VerificationResult;

const verifiers: Record<string, ToolVerifier> = {};

export function registerVerifier(toolName: string, verifier: ToolVerifier): void {
  verifiers[toolName] = verifier;
}

export function verifyToolResult(toolName: string, args: Record<string, unknown>, result: unknown): VerificationResult {
  const verifier = verifiers[toolName];
  if (!verifier) return { ok: true };
  try {
    return verifier(args, result);
  } catch (e) {
    // A verifier that itself throws shouldn't take the whole tool call
    // down with it - treat that as "couldn't verify," not "verified bad."
    return { ok: true, reason: `verifier threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}
