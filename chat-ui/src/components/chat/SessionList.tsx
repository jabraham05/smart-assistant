import type { HonchoSession } from "@/types/chat";

function formatSessionLabel(session: HonchoSession) {
  const date = new Date(session.created_at);
  return date.toLocaleString(undefined, {
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
  sessions: HonchoSession[];
  activeSessionId: string;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  isLoading: boolean;
}) {
  return (
    <div className="flex h-full w-56 flex-col border-r border-gray-200 dark:border-gray-700">
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
                className={`w-full truncate rounded px-2 py-1.5 text-left text-xs ${
                  session.id === activeSessionId
                    ? "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
                }`}
              >
                {formatSessionLabel(session)}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
