// Artifacts aggregates docs + every project + every coding task
// (getProjects/getCodingTasks/listDocs in page.tsx) - with enough of each,
// that request genuinely takes several seconds. Without this, navigating
// here shows nothing until it all resolves, which reads as a dead link.
export default function Loading() {
  return (
    <div className="flex h-full w-full items-center justify-center gap-2 text-sm text-zinc-500">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/15 border-t-indigo-400" />
      Loading artifacts…
    </div>
  );
}
