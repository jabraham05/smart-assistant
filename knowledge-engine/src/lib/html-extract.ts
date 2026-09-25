import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export interface ExtractedPage {
  title: string | null;
  text: string;
}

// Fetches a URL and strips it down to readable article text via
// Readability - the same "boilerplate-stripping" job it does for browser
// reader mode, reused here so ingested web pages and live web-research
// results (Phase 2) share one extraction path instead of two.
//
// Phase 4 of the infrastructure rebuild: the actual HTTP fetch tries
// scrapling-service first (real JS rendering + anti-bot fallback, see its
// own docs for why StealthyFetcher is a fallback, not the default),
// falling back to a plain fetch() only if scrapling-service is genuinely
// unreachable - not a hard dependency, same "clear degradation, not a
// crash" pattern used everywhere else in this project. Readability still
// does the actual article extraction either way - a real, live-verified
// finding this session was that Scrapling's own .markdown() conversion
// does NOT do Readability-style boilerplate stripping (tested against a
// real Wikipedia article, it returned the nav sidebar instead of the
// article), so scrapling-service hands back raw HTML, not pre-extracted
// content, and this function's own Readability pass runs on it either way.
export async function extractUrl(scraplingServiceUrl: string, url: string): Promise<ExtractedPage> {
  const html = await fetchHtml(scraplingServiceUrl, url);
  return extractFromHtml(html, url);
}

async function fetchHtml(scraplingServiceUrl: string, url: string): Promise<string> {
  try {
    const res = await fetch(`${scraplingServiceUrl}/fetch?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { html: string };
      if (body.html.trim()) return body.html;
    }
    console.error(`scrapling-service fetch failed for ${url} (${res.status}), falling back to plain fetch`);
  } catch (e) {
    console.error(`scrapling-service unreachable for ${url}, falling back to plain fetch:`, e);
  }

  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; SmartAssistantBot/1.0)" } });
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function extractFromHtml(html: string, url: string): ExtractedPage {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();

  const text = article?.textContent?.trim();
  if (!article || !text) {
    throw new Error(`could not extract readable content from ${url}`);
  }

  return { title: article.title || null, text };
}
