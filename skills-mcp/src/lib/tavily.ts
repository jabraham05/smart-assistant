const TAVILY_API_URL = "https://api.tavily.com/search";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
}

export interface TavilySearchOptions {
  topic?: "general" | "news";
  maxResults?: number;
}

// Tavily biases toward recent articles for topic="news" via its own "days"
// window; a fixed 3-day default suits "current headlines" asks without
// exposing another tunable the model would have to guess at.
const NEWS_DAYS = 3;

export async function tavilySearch(
  apiKey: string,
  query: string,
  options: TavilySearchOptions = {},
): Promise<TavilyResult[]> {
  const res = await fetch(TAVILY_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      topic: options.topic ?? "general",
      max_results: options.maxResults ?? 5,
      ...(options.topic === "news" ? { days: NEWS_DAYS } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tavily search failed: ${res.status} ${body}`.trim());
  }

  const data = (await res.json()) as {
    results: Array<{ title: string; url: string; content: string; published_date?: string }>;
  };

  return data.results.map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    publishedDate: r.published_date || undefined,
  }));
}
