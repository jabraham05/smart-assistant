"use client";

import { useEffect, useMemo, useState } from "react";
import { MarkdownContent } from "@/components/chat/MarkdownContent";

interface KnowledgeStoreFile {
  relativePath: string;
  size: number;
  mtime: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesView() {
  const [files, setFiles] = useState<KnowledgeStoreFile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | undefined>();

  useEffect(() => {
    setIsLoading(true);
    fetch("/api/knowledge-files")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setFiles(data.files ?? []))
      .catch(() => setError("Couldn't reach knowledge-engine."))
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    if (selectedPath === undefined) return;
    setContent(null);
    setContentError(undefined);
    fetch(`/api/knowledge-files/content?path=${encodeURIComponent(selectedPath)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setContent(data.content ?? ""))
      .catch(() => setContentError("Couldn't load this file's content."));
  }, [selectedPath]);

  const sortedFiles = useMemo(
    () => [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    [files],
  );

  return (
    <div className="flex h-full flex-col">
      <p className="mb-3 text-xs text-zinc-500">
        Every real file under knowledge-engine&apos;s knowledge store, on disk - not just the ones with an entities
        row (see the Growth tab). Useful for spotting orphaned or unexpected files.
      </p>
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="w-96 shrink-0 overflow-y-auto">
          {isLoading && <p className="text-xs text-zinc-600">Loading…</p>}
          {error && <p className="text-xs text-rose-400">{error}</p>}
          {!isLoading && !error && sortedFiles.length === 0 && (
            <p className="text-xs text-zinc-600">No files found in the knowledge store.</p>
          )}
          <ul className="space-y-1.5">
            {sortedFiles.map((file) => (
              <li
                key={file.relativePath}
                onClick={() => setSelectedPath(file.relativePath)}
                className={`cursor-pointer rounded-lg border p-2.5 transition-colors ${
                  selectedPath === file.relativePath
                    ? "border-indigo-500/40 bg-indigo-500/[0.06]"
                    : "border-white/5 bg-white/[0.02] hover:border-white/10"
                }`}
              >
                <p className="truncate font-mono text-xs text-zinc-200">{file.relativePath}</p>
                <p className="mt-0.5 text-[10px] text-zinc-600">
                  {formatSize(file.size)} · {new Date(file.mtime).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-white/10 bg-zinc-900/40 p-4">
          {selectedPath === undefined && <p className="text-xs text-zinc-600">Select a file to view its contents.</p>}
          {selectedPath !== undefined && contentError && <p className="text-xs text-rose-400">{contentError}</p>}
          {selectedPath !== undefined && !contentError && content === null && (
            <p className="text-xs text-zinc-600">Loading…</p>
          )}
          {selectedPath !== undefined && !contentError && content !== null && (
            selectedPath.endsWith(".md") ? (
              <MarkdownContent content={content} isUser={false} />
            ) : (
              <pre className="whitespace-pre-wrap text-xs text-zinc-300">{content}</pre>
            )
          )}
        </div>
      </div>
    </div>
  );
}
