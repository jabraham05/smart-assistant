import type { Config } from "../config.js";
import { runAgentLoop, truncateToolResult, type AgentTool } from "../agent-loop.js";
import { tavilySearch } from "../lib/tavily.js";
import { extractUrl } from "../lib/html-extract.js";
import { search } from "./search.js";

export interface Finding {
  claim: string;
  sourceUrls: string[];
}

export interface ResearchAgentResult {
  findings: Finding[];
  iterations: number;
  exhaustedIterations: boolean;
}

const SYSTEM_PROMPT = `You are Amy's research agent. Given a topic, find concrete, well-sourced facts about it.

Always call search_knowledge first to see what's already known before searching the web - don't rediscover
facts already in the knowledge base. Use web_search to find candidate pages, then fetch_page on the most
promising URLs to read their actual content (web_search results are only short snippets, not enough to cite
from directly). Call record_finding once for every concrete, citable fact you learn, with the real source
URL(s) that back it - not for vague impressions or your own summarizing commentary.

When you've recorded enough findings to answer the topic, or you've exhausted reasonable searches, reply with
a short plain-text summary and stop calling tools.`;

// Reimplements the old research_pipeline's "search repeatedly, end with a
// SOURCES: block parsed from prose" pattern as structured incremental tool
// calls instead - record_finding replaces the fragile regex-parsed
// SOURCES: block entirely, since the model now reports each source
// alongside the specific claim it backs, not just a flat list at the end.
export async function runResearchAgent(config: Config, topic: string, domain?: string): Promise<ResearchAgentResult> {
  const findings: Finding[] = [];

  const tools: AgentTool[] = [
    {
      name: "search_knowledge",
      description: "Search Amy's existing knowledge base for information already known about a topic.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      execute: async (args) => {
        const results = await search(config, { query: String(args.query), domain, topK: 5 });
        if (results.length === 0) return "No matching results in the knowledge base.";
        return results
          .map((r, i) => `[${i + 1}] (score ${r.score.toFixed(3)}) ${r.content}\nSource: ${r.source.url ?? r.documentTitle ?? "unknown"}`)
          .join("\n\n");
      },
    },
    {
      name: "web_search",
      description: "Search the live web for pages about a topic. Returns short snippets, not full page content - use fetch_page to read a promising result in full.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      execute: async (args) => {
        if (!config.tavilyApiKey) return "Error: web search is not configured.";
        const results = await tavilySearch(config.tavilyApiKey, String(args.query), { maxResults: 5 });
        return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`).join("\n\n");
      },
    },
    {
      name: "fetch_page",
      description: "Fetch and read the full text content of a specific URL, e.g. one found via web_search.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      execute: async (args) => {
        const page = await extractUrl(String(args.url));
        return truncateToolResult(page.text);
      },
    },
    {
      name: "record_finding",
      description: "Record one concrete, citable fact you've learned, with the real source URL(s) that back it.",
      parameters: {
        type: "object",
        properties: {
          claim: { type: "string" },
          sourceUrls: { type: "array", items: { type: "string" } },
        },
        required: ["claim", "sourceUrls"],
      },
      execute: async (args) => {
        const claim = String(args.claim);
        const sourceUrls = Array.isArray(args.sourceUrls) ? args.sourceUrls.map(String) : [];
        findings.push({ claim, sourceUrls });
        return "Recorded.";
      },
    },
  ];

  const loopResult = await runAgentLoop({
    ollamaHost: config.ollamaHost,
    model: config.researchModel,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Research topic: ${topic}`,
    tools,
    maxIterations: config.researchMaxIterations,
    label: `research topic="${topic}"`,
  });

  return { findings, iterations: loopResult.iterations, exhaustedIterations: loopResult.exhaustedIterations };
}
