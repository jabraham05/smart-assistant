import Link from "next/link";
import { RunDataDrilldown } from "@/components/workflows/RunDataDrilldown";

export default async function ExecutionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <div>
      <Link href="/workflows" className="mb-3 inline-block text-sm text-blue-600 underline dark:text-blue-400">
        ← Back to Workflows
      </Link>
      <RunDataDrilldown executionId={Number(id)} />
    </div>
  );
}
