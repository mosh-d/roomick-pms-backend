import { RegistrationCard } from '@prisma/client';
import { renderPdf } from '../../common/pdf/pdf.util';

/** The exact shape `RegistrationCardsService.generateCardInTx` writes into `RegistrationCard.fields` — this is the only place that snapshot is read back out. */
interface RegistrationCardFields {
  guestName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  roomNumber: string | null;
  roomType: string;
  checkInDate: string;
  checkOutDate: string;
  adults: number;
  children: number;
  rate: string;
  currency: string;
  confirmationNumber: string;
  houseRules: string | null;
  logoUrl: string | null;
}

function row(doc: PDFKit.PDFDocument, label: string, value: string) {
  doc.font('Helvetica-Bold').fontSize(10).text(label, { continued: true }).font('Helvetica').text(`  ${value}`);
}

/**
 * Renders the signed (or not-yet-signed) registration card as a PDF —
 * this is what `signCard` persists to encrypted document storage, and what
 * `GET /registration-cards/:id/download` streams for an unsigned card on
 * the fly (never persisted until it's actually signed — see the service's
 * own comment on `signCard`'s "not an afterthought" framing).
 */
export function renderRegistrationCardPdf(card: RegistrationCard): Promise<Buffer> {
  const f = card.fields as unknown as RegistrationCardFields;

  return renderPdf((doc) => {
    doc.fontSize(18).font('Helvetica-Bold').text('Guest Registration Card', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#555').text(`Confirmation ${f.confirmationNumber}`, { align: 'center' });
    doc.fillColor('#000');
    doc.moveDown(1.2);

    doc.fontSize(12).font('Helvetica-Bold').text('Guest');
    doc.moveDown(0.3);
    row(doc, 'Name:', f.guestName);
    if (f.guestEmail) row(doc, 'Email:', f.guestEmail);
    if (f.guestPhone) row(doc, 'Phone:', f.guestPhone);
    doc.moveDown(0.8);

    doc.fontSize(12).font('Helvetica-Bold').text('Stay');
    doc.moveDown(0.3);
    row(doc, 'Room:', f.roomNumber ? `${f.roomNumber} (${f.roomType})` : f.roomType);
    row(doc, 'Check-in:', f.checkInDate);
    row(doc, 'Check-out:', f.checkOutDate);
    row(doc, 'Guests:', `${f.adults} adult(s)${f.children ? `, ${f.children} child(ren)` : ''}`);
    row(doc, 'Rate:', `${f.currency} ${f.rate} / night`);
    doc.moveDown(0.8);

    if (f.houseRules) {
      doc.fontSize(12).font('Helvetica-Bold').text('House Rules');
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica').fillColor('#333').text(f.houseRules);
      doc.fillColor('#000');
      doc.moveDown(0.8);
    }

    doc.moveDown(1);
    doc.fontSize(12).font('Helvetica-Bold').text('Signature');
    doc.moveDown(0.3);
    if (card.signatureData && card.signedAt) {
      const base64 = card.signatureData.replace(/^data:image\/\w+;base64,/, '');
      doc.image(Buffer.from(base64, 'base64'), { fit: [220, 80] });
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica').fillColor('#555').text(`Signed and witnessed by hotel staff on ${card.signedAt.toISOString().slice(0, 10)}`);
      doc.fillColor('#000');
    } else {
      doc.fontSize(10).font('Helvetica-Oblique').fillColor('#888').text('Not yet signed.');
      doc.fillColor('#000');
    }
  });
}
