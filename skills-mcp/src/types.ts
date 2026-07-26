import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function textResult(data: string | object | unknown[]): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { content: [{ type: "text", text }] };
}

export function errorResult(msg: string): CallToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}
