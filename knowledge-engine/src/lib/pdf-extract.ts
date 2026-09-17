import { PDFParse } from "pdf-parse";

export interface ExtractedPdfPage {
  pageNumber: number;
  text: string;
}

export interface ExtractedPdf {
  totalPages: number;
  pages: ExtractedPdfPage[];
}

// pdf-parse v2's getText() natively returns per-page text with a real page
// number ({num, text}), so there's no need to render pages one at a time
// ourselves - the "per-page callback" originally considered in planning
// turned out to be unnecessary once the real library API was checked.
export async function extractPdf(buffer: Buffer): Promise<ExtractedPdf> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return {
      totalPages: result.total,
      pages: result.pages.map((p) => ({ pageNumber: p.num, text: p.text })),
    };
  } finally {
    await parser.destroy();
  }
}
