import type { Config } from "../config.js";
import { getGoogleAccessToken } from "./google-oauth.js";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

// Google's native formats (Docs/Sheets/Slides) have no raw bytes to
// download - they have to be exported to a plain format instead. Picked
// one reasonable export target per type rather than exposing the choice
// as a tool parameter, matching this project's general preference for a
// sensible default over more surface area.
const EXPORT_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

async function driveFetch(config: Config, path: string): Promise<Response> {
  const accessToken = await getGoogleAccessToken(config);
  const res = await fetch(`${DRIVE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Drive API failed: ${res.status} ${body}`);
  }
  return res;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export async function searchFiles(config: Config, query: string, maxResults: number): Promise<DriveFile[]> {
  // Matches on name OR full-text content - a plain keyword search is the
  // common case ("find my resume"), not something worth a separate tool
  // parameter to choose between the two.
  const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `trashed = false and (name contains '${escaped}' or fullText contains '${escaped}')`,
    pageSize: String(maxResults),
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  });
  const res = await driveFetch(config, `/files?${params}`);
  const data = (await res.json()) as { files?: DriveFile[] };
  return data.files ?? [];
}

// Real cap, not arbitrary: this is read into memory as text and handed to
// the model - a multi-hundred-page PDF or large spreadsheet export would
// blow the context window for no benefit, so truncate rather than fail.
const MAX_CONTENT_CHARS = 20_000;

export async function getFileContent(config: Config, fileId: string): Promise<{ name: string; content: string }> {
  const metaRes = await driveFetch(config, `/files/${encodeURIComponent(fileId)}?fields=name,mimeType`);
  const meta = (await metaRes.json()) as { name: string; mimeType: string };

  const exportMimeType = EXPORT_MIME_TYPES[meta.mimeType];
  const accessToken = await getGoogleAccessToken(config);
  const url = exportMimeType
    ? `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMimeType)}`
    : `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Drive API failed: ${res.status} ${body}`);
  }

  // A binary file with no export path (an image, a zip, a PDF - Drive
  // doesn't export PDFs to text) would come back here as raw bytes
  // decoded as text, producing garbage rather than a clean error. Only
  // trust this for anything we know is actually text: Google's own
  // exported formats, or a mimeType that's already text/*.
  if (!exportMimeType && !meta.mimeType.startsWith("text/")) {
    throw new Error(
      `"${meta.name}" is a ${meta.mimeType} file - only Google Docs/Sheets/Slides and plain text files can be read as text right now.`,
    );
  }

  const content = await res.text();
  return {
    name: meta.name,
    content: content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS)}\n...(truncated)` : content,
  };
}
