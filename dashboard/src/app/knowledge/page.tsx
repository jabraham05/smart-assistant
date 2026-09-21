import { SearchForm } from "@/components/knowledge/SearchForm";

export default function KnowledgePage() {
  return (
    <div>
      <h1 className="mb-3 text-lg font-semibold">Knowledge Search</h1>
      <p className="mb-4 text-sm text-black/60 dark:text-white/60">
        Runs the exact same hybrid (vector + keyword) search knowledge-engine
        uses for the <code>knowledge_search</code> tool.
      </p>
      <SearchForm />
    </div>
  );
}
