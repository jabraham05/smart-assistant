import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { getFileContent, searchFiles } from "../lib/google-drive.js";
import { errorResult, textResult } from "../types.js";

// Shares the same Google OAuth refresh token calendar_event uses (see
// google-oauth.ts / scripts/google-auth.mjs) - one consent screen covers
// both, rather than a second, separate Drive-specific auth setup.
// Read-only on purpose for now (search + read content) - no upload/
// delete/sharing surface until there's an actual demonstrated need for
// it, same "don't build for hypothetical future requirements" reasoning
// as everywhere else in this project.
export function registerDriveSearch(server: McpServer, config: Config): void {
  server.registerTool(
    "drive_search",
    {
      title: "Search and read files in the user's Google Drive",
      description:
        "Search the user's Google Drive by name or content, or read a specific file's text " +
        "content. Use when the user asks to find, look up, or read something from their " +
        "Drive, a Google Doc, a Sheet, or a file they mention having stored in Drive - NOT for " +
        "Amy's own saved knowledge/research (that's knowledge_search). action='search' returns " +
        "matching files with their id, name, and a link - use the id with action='read' to get " +
        "a file's actual text content. Google Docs/Sheets/Slides are read as plain text/CSV " +
        "automatically; other file types only work if they're already plain text - binary " +
        "files (images, PDFs, zips) will return a clear error, not garbage.",
      inputSchema: {
        action: z.enum(["search", "read"]).describe("Which operation to perform."),
        query: z.string().optional().describe("search: the search text (matches file name or content). Required for action='search'."),
        maxResults: z.coerce.number().int().min(1).max(20).optional().describe("search: max files to return (default 10)."),
        fileId: z.string().optional().describe("read: the file's id, from action='search'. Required for action='read'."),
      },
    },
    async ({ action, query, maxResults, fileId }) => {
      try {
        if (action === "search") {
          if (!query?.trim()) return errorResult("query is required for action='search'.");
          const files = await searchFiles(config, query, maxResults ?? 10);
          if (files.length === 0) return textResult("No matching files found in Drive.");
          return textResult(
            files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, webViewLink: f.webViewLink })),
          );
        }

        // action === "read"
        if (!fileId?.trim()) return errorResult("fileId is required for action='read'.");
        const { name, content } = await getFileContent(config, fileId);
        return textResult({ name, content });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return errorResult(`drive_search failed: ${message}`);
      }
    },
  );
}
