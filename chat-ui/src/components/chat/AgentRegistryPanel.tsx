import type { RegisteredTool } from "@/types/chat";
import { groupForTool, groupLabel } from "@/lib/tool-groups";

function groupTools(tools: RegisteredTool[]): [string, RegisteredTool[]][] {
  const byGroup = new Map<string, RegisteredTool[]>();
  for (const tool of tools) {
    const group = groupForTool(tool.name);
    const list = byGroup.get(group) ?? [];
    list.push(tool);
    byGroup.set(group, list);
  }
  // "other" (calculate/task_context_manage - always bound regardless of
  // classification) sorts last, everything else alphabetically by label.
  return [...byGroup.entries()].sort(([a], [b]) => {
    if (a === "other") return 1;
    if (b === "other") return -1;
    return groupLabel(a).localeCompare(groupLabel(b));
  });
}

function ToolRow({ tool }: { tool: RegisteredTool }) {
  return (
    <li className="rounded border border-gray-200 p-2 dark:border-gray-700">
      <p className="text-xs font-medium text-gray-700 dark:text-gray-200">
        {tool.title} <code className="ml-1 text-[10px] text-blue-600 dark:text-blue-400">{tool.name}</code>
      </p>
      <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{tool.description}</p>
    </li>
  );
}

export function AgentRegistryPanel({
  tools,
  isLoading,
  error,
  onRefresh,
}: {
  tools: RegisteredTool[];
  isLoading: boolean;
  error?: string;
  onRefresh: () => void;
}) {
  const groups = groupTools(tools);

  return (
    <div className="flex h-full w-96 flex-col border-l border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between border-b border-gray-200 p-2 dark:border-gray-700">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
          agent registry {tools.length > 0 && `(${tools.length})`}
        </span>
        <button
          onClick={onRefresh}
          disabled={isLoading}
          className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-900/30"
        >
          {isLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {error && <p className="px-1 py-2 text-xs text-red-500">{error}</p>}
        {!error && !isLoading && tools.length === 0 && (
          <p className="px-1 py-2 text-xs text-gray-400">No tools found.</p>
        )}
        <div className="space-y-3">
          {groups.map(([group, groupTools]) => (
            <div key={group}>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                {groupLabel(group)}
              </p>
              <ul className="space-y-1.5">
                {groupTools.map((tool) => (
                  <ToolRow key={tool.name} tool={tool} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
