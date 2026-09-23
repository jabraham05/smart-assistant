import type { EnrichedSession, SessionOrigin } from "@/types/chat";

const ORIGIN_LABEL: Record<SessionOrigin, string> = {
  discord: "Discord",
  cli: "CLI",
  chat: "Chat",
};

const ORIGIN_COLOR: Record<SessionOrigin, string> = {
  discord: "bg-indigo-500/10 text-indigo-300",
  cli: "bg-amber-500/10 text-amber-300",
  chat: "bg-white/5 text-zinc-400",
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onNewSession,
  isLoading,
}: {
  sessions: EnrichedSession[];
  activeSessionId: string;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  isLoading: boolean;
}) {
  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-white/10">
      <div className="p-2.5">
        <button
          onClick={onNewSession}
          className="w-full rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
        >
          + New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {isLoading && <p className="px-1.5 py-2 text-xs text-zinc-600">Loading sessions…</p>}
        {!isLoading && sessions.length === 0 && (
          <p className="px-1.5 py-2 text-xs text-zinc-600">No past sessions yet.</p>
        )}
        <ul className="space-y-0.5">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                onClick={() => onSelect(session.id)}
                title={session.id}
                className={`w-full rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                  session.id === activeSessionId
                    ? "bg-indigo-500/10 text-indigo-200"
                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wide ${ORIGIN_COLOR[session.origin]}`}
                  >
                    {ORIGIN_LABEL[session.origin]}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-zinc-600">{formatTime(session.lastMessageAt)}</span>
                </div>
                <p className="mt-1 truncate">{session.preview}</p>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
