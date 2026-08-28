import PDFDocument from 'pdfkit';

/**
 * Buffers a pdfkit document to a `Buffer` — pdfkit itself is stream-only,
 * so every PDF-producing caller in this codebase (registration cards,
 * report exports) shares this instead of re-writing the same
 * chunks/`end`-event plumbing.
 */
export function renderPdf(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  draw(doc);
  doc.end();
  return done;
}
