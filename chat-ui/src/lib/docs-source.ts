import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// docs/ and README.md (as readme.md) are baked into the image at build
// time (see chat-ui/Dockerfile) rather than bind-mounted - confirmed live
// on the old ops-dashboard that bind mounts get stuck as empty on this
// machine's Docker Desktop, the same failure mode already documented for
// skills-mcp's Google Calendar key file. A doc edit needs a rebuild to
// show up.
const DOCS_DIR = "/app/docs";

export interface DocEntry {
  slug: string;
  title: string;
}

export async function listDocs(): Promise<DocEntry[]> {
  const files = await readdir(DOCS_DIR);
  const entries = files
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ slug: f.replace(/\.md$/, ""), title: titleCase(f.replace(/\.md$/, "")) }));

  entries.sort((a, b) => (a.slug === "readme" ? -1 : b.slug === "readme" ? 1 : a.title.localeCompare(b.title)));
  return entries;
}

export async function readDoc(slug: string): Promise<string> {
  // path.join with a slug containing ".." could otherwise escape DOCS_DIR -
  // reject anything that isn't a plain filename segment before touching fs.
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error("invalid doc slug");
  }
  return readFile(path.join(DOCS_DIR, `${slug}.md`), "utf8");
}

function titleCase(slug: string): string {
  if (slug === "readme") return "README";
  return slug
    .split("-")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}
