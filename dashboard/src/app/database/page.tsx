import { QueryEditor } from "@/components/database/QueryEditor";

export default function DatabasePage() {
  return (
    <div>
      <h1 className="mb-3 text-lg font-semibold">Database</h1>
      <QueryEditor />
    </div>
  );
}
