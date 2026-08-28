import { renderPdf } from '../../common/pdf/pdf.util';

export interface ReportPdfTable {
  heading: string;
  columns: string[];
  rows: string[][];
}

/** The one shape all four report types (Occupancy/ADR/RevPAR/Revenue) reduce to for PDF export — each has a different `summary`/`byX` shape in its JSON response, but the same "title + date range + summary + tables" print layout. */
export interface ReportPdfSpec {
  title: string;
  from: string;
  to: string;
  summary: Array<{ label: string; value: string }>;
  tables: ReportPdfTable[];
}

function drawTable(doc: PDFKit.PDFDocument, table: ReportPdfTable) {
  const left = doc.page.margins.left;
  const usableWidth = doc.page.width - left - doc.page.margins.right;
  const colWidth = usableWidth / table.columns.length;

  doc.fontSize(11).font('Helvetica-Bold').text(table.heading);
  doc.moveDown(0.3);

  doc.fontSize(9).font('Helvetica-Bold');
  let headerY = doc.y;
  table.columns.forEach((col, i) => doc.text(col, left + i * colWidth, headerY, { width: colWidth }));
  doc.y = headerY + 14;
  doc.moveTo(left, doc.y).lineTo(left + usableWidth, doc.y).strokeColor('#ccc').stroke();
  doc.moveDown(0.3);

  doc.font('Helvetica');
  for (const cells of table.rows) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage();
      headerY = doc.y;
    }
    const rowY = doc.y;
    cells.forEach((cell, i) => doc.text(cell, left + i * colWidth, rowY, { width: colWidth }));
    doc.y = rowY + 14;
  }
  doc.moveDown(1);
}

export function renderReportPdf(spec: ReportPdfSpec): Promise<Buffer> {
  return renderPdf((doc) => {
    doc.fontSize(18).font('Helvetica-Bold').text(spec.title, { align: 'center' });
    doc.moveDown(0.2);
    doc.fontSize(10).font('Helvetica').fillColor('#555').text(`${spec.from} to ${spec.to}`, { align: 'center' });
    doc.fillColor('#000');
    doc.moveDown(1);

    doc.fontSize(12).font('Helvetica-Bold').text('Summary');
    doc.moveDown(0.3);
    for (const s of spec.summary) {
      doc.fontSize(10).font('Helvetica-Bold').text(`${s.label}: `, { continued: true }).font('Helvetica').text(s.value);
    }
    doc.moveDown(1);

    for (const table of spec.tables) drawTable(doc, table);
  });
}
