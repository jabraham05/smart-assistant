export function RegistrySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="mb-4 rounded-md border border-black/10 dark:border-white/10" open>
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{title}</summary>
      <div className="border-t border-black/10 p-3 dark:border-white/10">{children}</div>
    </details>
  );
}
