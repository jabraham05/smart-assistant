"use client";

import { useEffect, useState } from "react";
import { RegistrySection } from "./RegistrySection";

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

interface RegistryData {
  mcpTools: McpToolInfo[] | { error: string };
  capabilityGroups: { groups: Record<string, string[]>; alwaysOnTools: string[] } | { error: string };
  codingOrchestratorRoles: { name: string; source: string; description: string }[];
}

export function RegistryView() {
  const [data, setData] = useState<RegistryData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/registry")
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <p className="text-sm text-black/50 dark:text-white/50">Loading...</p>;

  return (
    <div>
      <RegistrySection title="skills-mcp: live MCP tool catalog">
        {"error" in data.mcpTools ? (
          <p className="text-sm text-red-600 dark:text-red-400">{data.mcpTools.error}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {data.mcpTools.map((tool) => (
              <div key={tool.name} className="text-sm">
                <div className="font-medium">{tool.name}</div>
                {tool.description && <div className="text-black/60 dark:text-white/60">{tool.description}</div>}
                <pre className="mt-1 overflow-auto rounded bg-black/[.03] p-2 text-xs dark:bg-white/[.05]">
                  {JSON.stringify(tool.inputSchema, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </RegistrySection>

      <RegistrySection title="Chat capability groups (n8n's live GROUPS mapping)">
        {"error" in data.capabilityGroups ? (
          <p className="text-sm text-red-600 dark:text-red-400">{data.capabilityGroups.error}</p>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            {Object.entries(data.capabilityGroups.groups).map(([group, tools]) => (
              <div key={group}>
                <span className="font-medium">{group}</span>: {tools.join(", ")}
              </div>
            ))}
            <div>
              <span className="font-medium">always-on</span>: {data.capabilityGroups.alwaysOnTools.join(", ")}
            </div>
          </div>
        )}
      </RegistrySection>

      <RegistrySection title="coding-orchestrator roles (hardcoded, no dynamic discovery)">
        <div className="flex flex-col gap-2 text-sm">
          {data.codingOrchestratorRoles.map((role) => (
            <div key={role.name}>
              <span className="font-medium">{role.name}</span>{" "}
              <span className="text-black/50 dark:text-white/50">({role.source})</span> — {role.description}
            </div>
          ))}
        </div>
      </RegistrySection>
    </div>
  );
}
