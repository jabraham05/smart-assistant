// Deliberately duplicated from skills-mcp/src/lib/tavily.ts rather than
// shared as a package - same convention this project already uses for
// small cross-service functions (see notify.ts's own comment). Only the
// "news" topic path is needed here for the overnight digest.

const TAVILY_API_URL = "https://api.tavily.com/search";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

const NEWS_DAYS = 1;

export async function tavilyNewsSearch(apiKey: string, query: string, maxResults = 5): Promise<TavilyResult[]> {
  const res = await fetch(TAVILY_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, topic: "news", days: NEWS_DAYS, max_results: maxResults }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tavily search failed: ${res.status} ${body}`.trim());
  }
  const data = (await res.json()) as { results: Array<{ title: string; url: string; content: string }> };
  return data.results.map((r) => ({ title: r.title, url: r.url, content: r.content }));
}
