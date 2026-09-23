import { listDocs } from "@/lib/docs-source";
import { getProjects } from "@/lib/knowledge-engine-client";
import { getCodingTasks } from "@/lib/coding-orchestrator-client";
import { ArtifactRegistry } from "@/components/artifacts/ArtifactRegistry";

// force-dynamic: listDocs reads the docs/ directory baked into the image
// at build time (see chat-ui/Dockerfile) - same runtime-read requirement
// the old ops-dashboard's docs page had, for the same reason (the docs/
// folder doesn't exist yet during the Docker build stage).
export const dynamic = "force-dynamic";

export default async function ArtifactsPage() {
  const [docs, projects, codingTasks] = await Promise.all([
    listDocs().catch(() => []),
    getProjects().catch(() => []),
    getCodingTasks().catch(() => []),
  ]);

  return <ArtifactRegistry docs={docs} projects={projects} codingTasks={codingTasks} />;
}
