// Deterministic (not LLM) heading detection over a page's raw extracted
// text. Best-effort only: raw PDF text extraction frequently loses visual
// heading cues (font size/bold) entirely, so this can legitimately find
// nothing on a given page - callers should treat a null return as "no
// heading available," not an error. page_number (always present, from
// pdf-extract.ts) remains a real citation regardless of whether this finds
// anything, so there's no separate "fallback mode" to toggle - a page with
// no detected heading just has heading: null, and the chunk is still
// correctly attributed to its page.
//
// Checks only the first few lines of a page, since a heading (if visually
// present at all in the source) almost always opens the page rather than
// appearing mid-paragraph.
// 2026-09-17 - real evidence from ingesting an actual PDF (the Bitcoin
// whitepaper): "2. Transactions"/"4. Proof-of-Work"-style headings
// (number, period, space) are the common case, not "4.2 Fuel Injectors"
// (number, space, no period) - the original regex required whitespace
// immediately after the digit group and missed every real heading in that
// document. The `\.?` here is what was missing.
const NUMBERED_SECTION = /^(\d+(?:\.\d+)*)\.?\s+([A-Z][A-Za-z0-9 ,/&'-]{2,60})$/;
const ALL_CAPS_HEADING = /^[A-Z][A-Z0-9 ,/&'-]{2,60}$/;

const LINES_TO_CHECK = 5;
const MAX_HEADING_LENGTH = 80;

export function detectHeading(pageText: string): string | null {
  const lines = pageText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, LINES_TO_CHECK);

  for (const line of lines) {
    if (line.length > MAX_HEADING_LENGTH) continue;

    const numbered = line.match(NUMBERED_SECTION);
    if (numbered) return line;

    if (ALL_CAPS_HEADING.test(line)) return line;
  }

  return null;
}
