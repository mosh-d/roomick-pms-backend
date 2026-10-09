import { renderPdf } from '../../common/pdf/pdf.util';

export interface InvoicePdfSpec {
  propertyName: string;
  propertyAddress: string | null;
  number: string;
  issuedOn: string;
  dueOn: string | null;
  /** Set on an invoice issued again after the bill changed — the one it replaced. */
  replaces: string | null;
  /** Set on a replaced invoice: the one that replaced it. */
  replacedBy: string | null;
  billTo: string[];
  stay: string[];
  currency: string;
  lines: Array<{ date: string; description: string; amount: string; tax: string }>;
  subTotal: string;
  taxes: Array<{ name: string; amount: string }>;
  total: string;
  payments: Array<{ date: string; description: string; amount: string }>;
  paid: string;
  balanceDue: string;
}

type Column = { label: string; x: number; width: number; align: 'left' | 'right' };

/**
 * The invoice a guest or a company is given for a bill. Money is printed with
 * the currency code beside it, not a symbol: the standard PDF fonts can't
 * draw ₦.
 */
export function renderInvoicePdf(spec: InvoicePdfSpec): Promise<Buffer> {
  return renderPdf((doc) => {
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;

    const rule = () => {
      doc.moveDown(0.4);
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#bbbbbb').stroke();
      doc.moveDown(0.6);
    };

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#000000').text(spec.propertyName, left, doc.y);
    if (spec.propertyAddress) doc.fontSize(9).font('Helvetica').fillColor('#555555').text(spec.propertyAddress, { width });
    doc.fillColor('#000000');
    doc.moveDown(0.6);
    doc.fontSize(20).font('Helvetica-Bold').text(spec.replacedBy ? 'INVOICE (REPLACED)' : 'INVOICE', left, doc.y);
    doc.fontSize(10).font('Helvetica');
    doc.text(`Invoice number: ${spec.number}`);
    doc.text(`Issued: ${spec.issuedOn}`);
    doc.text(`Due: ${spec.dueOn ?? 'On receipt'}`);
    if (spec.replaces) doc.text(`Replaces invoice ${spec.replaces}`);
    if (spec.replacedBy) doc.fillColor('#b00020').text(`Replaced by invoice ${spec.replacedBy} — this one is no longer payable.`).fillColor('#000000');
    rule();

    const top = doc.y;
    const half = width / 2 - 10;
    doc.fontSize(9).font('Helvetica-Bold').text('BILL TO', left, top, { width: half });
    doc.font('Helvetica').fontSize(10);
    for (const line of spec.billTo) doc.text(line, left, doc.y, { width: half });
    const leftEnd = doc.y;
    doc.fontSize(9).font('Helvetica-Bold').text('STAY', left + half + 20, top, { width: half });
    doc.font('Helvetica').fontSize(10);
    for (const line of spec.stay) doc.text(line, left + half + 20, doc.y, { width: half });
    doc.y = Math.max(leftEnd, doc.y);
    doc.x = left;
    rule();

    const columns: Column[] = [
      { label: 'Date', x: left, width: width * 0.16, align: 'left' },
      { label: 'Description', x: left + width * 0.16, width: width * 0.48, align: 'left' },
      { label: `Amount (${spec.currency})`, x: left + width * 0.64, width: width * 0.18, align: 'right' },
      { label: `Tax (${spec.currency})`, x: left + width * 0.82, width: width * 0.18, align: 'right' },
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
      doc.x = left;
    };
    row(columns.map((c) => c.label), true);
    if (spec.lines.length === 0) row(['', 'Nothing has been charged to this bill.', '', '']);
    for (const line of spec.lines) row([line.date, line.description, line.amount, line.tax]);
    doc.moveDown(0.4);

    const total = (label: string, value: string, bold = false) => row(['', label, '', value], bold);
    total('Subtotal', spec.subTotal);
    for (const tax of spec.taxes) total(tax.name, tax.amount);
    total('Total', spec.total, true);
    rule();

    doc.fontSize(9).font('Helvetica-Bold').text('PAYMENTS RECEIVED', left, doc.y);
    doc.moveDown(0.2);
    if (spec.payments.length === 0) row(['', 'None yet.', '', '']);
    for (const payment of spec.payments) row([payment.date, payment.description, '', payment.amount]);
    total('Paid', spec.paid);
    total(Number(spec.balanceDue) < 0 ? 'Credit to the guest' : 'Balance due', spec.balanceDue.replace(/^-/, ''), true);
  });
}
