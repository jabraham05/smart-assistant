// Shared timeout for internal service-to-service calls (chat-ui is always
// on the same docker network as everything it talks to, so 8s is generous
// for a healthy dependency and still bounds the worst case tightly for a
// hung one). Real bug this fixes: /artifacts did a blocking Promise.all of
// three service calls with no timeout anywhere - an up-but-hung
// knowledge-engine or coding-orchestrator (container running, port open,
// not responding, as opposed to connection-refused, which already failed
// fast into each call's own .catch(() => [])) made the whole page hang
// indefinitely instead of degrading to an empty tab.
export const FETCH_TIMEOUT_MS = 8000;

export function fetchTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

// For non-fetch async work (docs-source.ts's fs reads) that has no
// AbortSignal of its own - same bound, applied via Promise.race instead.
export function withTimeout<T>(promise: Promise<T>, ms: number = FETCH_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}
