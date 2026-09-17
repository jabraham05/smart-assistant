import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export interface ExtractedPage {
  title: string | null;
  text: string;
}

// Fetches a URL and strips it down to readable article text - the same
// "boilerplate-stripping" job Readability does for browser reader mode,
// reused here so ingested web pages and live web-research results (Phase 2)
// share one extraction path instead of two.
export async function extractUrl(url: string): Promise<ExtractedPage> {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; SmartAssistantBot/1.0)" } });
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();

  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();

  const text = article?.textContent?.trim();
  if (!article || !text) {
    throw new Error(`could not extract readable content from ${url}`);
  }

  return { title: article.title || null, text };
}
