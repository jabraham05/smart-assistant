import type { EnrichedSession, SessionOrigin } from "@/types/chat";

const ORIGIN_LABEL: Record<SessionOrigin, string> = {
  discord: "Discord",
  cli: "CLI",
  chat: "Chat",
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
    <div className="flex h-full w-72 flex-col border-r border-gray-200 dark:border-gray-700">
      <div className="p-2">
        <button
          onClick={onNewSession}
          className="w-full rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
        >
          + New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {isLoading && (
          <p className="px-1 py-2 text-xs text-gray-400">Loading sessions…</p>
        )}
        {!isLoading && sessions.length === 0 && (
          <p className="px-1 py-2 text-xs text-gray-400">No past sessions yet.</p>
        )}
        <ul className="space-y-0.5">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                onClick={() => onSelect(session.id)}
                title={session.id}
                className={`w-full rounded px-2 py-1.5 text-left text-xs ${
                  session.id === activeSessionId
                    ? "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                      session.origin === "discord"
                        ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300"
                        : session.origin === "cli"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
                          : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                    }`}
                  >
                    {ORIGIN_LABEL[session.origin]}
                  </span>
                  <span className="shrink-0 text-[10px] text-gray-400">{formatTime(session.lastMessageAt)}</span>
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
