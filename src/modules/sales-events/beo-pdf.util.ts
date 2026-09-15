import { renderPdf } from '../../common/pdf/pdf.util';

export interface BeoPdfSpec {
  propertyName: string;
  beoNumber: string;
  printedOn: string;
  title: string;
  date: string;
  time: string;
  venue: string;
  setup: string;
  headcount: string;
  contact: string;
  catering: Array<{ description: string; quantity: string; unitPrice: string; amount: string }>;
  subtotal: string;
  tax: string;
  total: string;
  avRequirements: string | null;
  notes: string | null;
}

type Column = { label: string; x: number; width: number; align: 'left' | 'right' };

/**
 * A Banquet Event Order — the one sheet the kitchen, the banqueting team and
 * the client all work from and sign. Money is printed with the currency code,
 * not a symbol: the standard PDF fonts can't draw ₦.
 */
export function renderBeoPdf(spec: BeoPdfSpec): Promise<Buffer> {
  return renderPdf((doc) => {
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;

    const rule = () => {
      doc.moveDown(0.4);
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#bbbbbb').stroke();
      doc.moveDown(0.6);
    };
    const heading = (text: string) => {
      if (doc.y > bottom() - 60) doc.addPage();
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000').text(text.toUpperCase(), left, doc.y);
      doc.moveDown(0.3);
    };
    const field = (label: string, value: string) => {
      doc.fontSize(10).font('Helvetica-Bold').text(`${label}: `, left, doc.y, { continued: true }).font('Helvetica').text(value);
    };
    const paragraph = (text: string) => {
      doc.fontSize(10).font('Helvetica').text(text, left, doc.y, { width });
    };

    doc.fontSize(16).font('Helvetica-Bold').text(spec.propertyName, { align: 'center' });
    doc.fontSize(12).font('Helvetica').text('Banquet Event Order', { align: 'center' });
    doc.fontSize(9).fillColor('#555555').text(`${spec.beoNumber}  ·  Printed ${spec.printedOn}`, { align: 'center' });
    doc.fillColor('#000000');
    rule();

    heading('Event');
    field('Event', spec.title);
    field('Date', spec.date);
    field('Time', spec.time);
    field('Venue', spec.venue);
    field('Setup', spec.setup);
    field('Guaranteed headcount', spec.headcount);
    field('Contact', spec.contact);
    rule();

    heading('Catering');
    if (spec.catering.length === 0) {
      paragraph('No catering on this event.');
    } else {
      const columns: Column[] = [
        { label: 'Item', x: left, width: width * 0.5, align: 'left' },
        { label: 'Qty', x: left + width * 0.5, width: width * 0.1, align: 'right' },
        { label: 'Unit price', x: left + width * 0.6, width: width * 0.2, align: 'right' },
        { label: 'Amount', x: left + width * 0.8, width: width * 0.2, align: 'right' },
      ];
      const row = (cells: string[], bold = false) => {
        if (doc.y > bottom() - 24) doc.addPage();
        const y = doc.y;
        doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica');
        let tallest = 0;
        cells.forEach((cell, i) => {
          const column = columns[i];
          if (!column) return;
          doc.text(cell, column.x, y, { width: column.width - 6, align: column.align });
          tallest = Math.max(tallest, doc.y - y);
        });
        doc.y = y + Math.max(tallest, 12) + 3;
      };
      row(columns.map((c) => c.label), true);
      for (const line of spec.catering) row([line.description, line.quantity, line.unitPrice, line.amount]);
      doc.moveDown(0.3);
      row(['', '', 'Subtotal', spec.subtotal]);
      row(['', '', 'Tax (estimate)', spec.tax]);
      row(['', '', 'Total', spec.total], true);
    }
    rule();

    heading('AV & equipment');
    paragraph(spec.avRequirements ?? 'None requested.');
    doc.moveDown(0.8);
    heading('Notes & special instructions');
    paragraph(spec.notes ?? 'None.');
    rule();

    if (doc.y > bottom() - 90) doc.addPage();
    doc.moveDown(2);
    const lineY = doc.y;
    const half = width / 2 - 12;
    doc.moveTo(left, lineY).lineTo(left + half, lineY).strokeColor('#000000').stroke();
    doc.moveTo(left + half + 24, lineY).lineTo(left + width, lineY).stroke();
    doc.fontSize(9).font('Helvetica').text('Client — signature and date', left, lineY + 4, { width: half });
    doc.text('Events manager — signature and date', left + half + 24, lineY + 4, { width: half });
  });
}
