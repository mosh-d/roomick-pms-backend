process.env.ENCRYPTION_KEY = 'c'.repeat(64);

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { DOCUMENT_STORAGE_ADAPTER } from '../../common/documents/document-storage.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { RegistrationCardsService } from './registration-cards.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';

const CARD_FIELDS = {
  guestName: 'John Doe',
  guestEmail: 'john@doe.com',
  guestPhone: '0801234567',
  roomNumber: '204',
  roomType: 'Deluxe Room',
  checkInDate: '2026-09-01',
  checkOutDate: '2026-09-04',
  adults: 2,
  children: 0,
  rate: '300.00',
  currency: 'NGN',
  confirmationNumber: 'RES-2026-00001',
  houseRules: 'No smoking.',
  logoUrl: null,
};

// A real, minimal, valid 1x1 PNG — pdfkit's `doc.image()` parses actual
// image bytes (format signature, IHDR, etc.), so a placeholder string like
// `'data:image/png;base64,x'` throws "Unknown image format" once
// `renderRegistrationCardPdf` actually embeds it.
const SIGNATURE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function reservationForCard(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RESERVATION_ID,
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    guestId: 'guest-1',
    confirmationNumber: 'RES-2026-00001',
    confirmedRate: new Prisma.Decimal('300'),
    checkInDate: new Date('2026-09-01T00:00:00.000Z'),
    checkOutDate: new Date('2026-09-04T00:00:00.000Z'),
    adults: 2,
    children: 0,
    status: 'checked_in',
    guest: { name: 'John Doe', email: 'john@doe.com', phone: '0801234567' },
    roomType: { name: 'Deluxe Room' },
    room: { number: '204' },
    branch: { currency: 'NGN', regCardTemplate: { houseRules: 'No smoking.', logoUrl: null } },
    ...overrides,
  };
}

function makeTx() {
  return {
    registrationCard: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'card-1', signedAt: null, signatureData: null, ...data })),
      // Real signCard calls update() twice (signature, then documentUrl) —
      // `fields` must survive both, the same way a real UPDATE ... RETURNING
      // would, or the PDF renderer sees an undefined snapshot on call #1.
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'card-1', fields: CARD_FIELDS, ...data })),
    },
    reservation: { findFirst: jest.fn().mockResolvedValue(reservationForCard()) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('RegistrationCardsService', () => {
  let service: RegistrationCardsService;
  let tx: ReturnType<typeof makeTx>;
  let documentStorage: { write: jest.Mock; read: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    documentStorage = { write: jest.fn().mockResolvedValue('file:///fake/card.pdf.enc'), read: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        RegistrationCardsService,
        EncryptionService,
        { provide: DOCUMENT_STORAGE_ADAPTER, useValue: documentStorage },
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
      ],
    }).compile();
    service = moduleRef.get(RegistrationCardsService);
  });

  describe('generateCardInTx', () => {
    it('snapshots guest/stay/rate/house-rules into fields', async () => {
      const card = await service.generateCardInTx(tx as never, TENANT_ID, reservationForCard(), ACTOR_ID);
      expect(tx.registrationCard.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            branchId: BRANCH_ID,
            reservationId: RESERVATION_ID,
            guestId: 'guest-1',
            fields: expect.objectContaining({
              guestName: 'John Doe',
              roomNumber: '204',
              roomType: 'Deluxe Room',
              rate: '300.00',
              currency: 'NGN',
              houseRules: 'No smoking.',
            }),
          }),
        }),
      );
      expect(card).toBeDefined();
    });

    it('is idempotent — returns the existing card instead of creating a second one', async () => {
      tx.registrationCard.findFirst.mockResolvedValue({ id: 'existing-card' });
      const card = await service.generateCardInTx(tx as never, TENANT_ID, reservationForCard(), ACTOR_ID);
      expect(card).toEqual({ id: 'existing-card' });
      expect(tx.registrationCard.create).not.toHaveBeenCalled();
    });

    it('does NOT snapshot any ID-document field — CreateGuestDto never collects one, so there is nothing real to put there', async () => {
      await service.generateCardInTx(tx as never, TENANT_ID, reservationForCard(), ACTOR_ID);
      const fields = (tx.registrationCard.create.mock.calls[0] as [{ data: { fields: Record<string, unknown> } }])[0].data.fields;
      expect(fields).not.toHaveProperty('idDocNumber');
      expect(fields).not.toHaveProperty('nationality');
    });

    it('a branch with no template set yet still generates a card, with null house rules', async () => {
      await service.generateCardInTx(tx as never, TENANT_ID, reservationForCard({ branch: { currency: 'NGN', regCardTemplate: null } }), ACTOR_ID);
      const fields = (tx.registrationCard.create.mock.calls[0] as [{ data: { fields: Record<string, unknown> } }])[0].data.fields;
      expect(fields.houseRules).toBeNull();
    });
  });

  describe('generateCard — the manual/backfill path', () => {
    it('404s on a missing reservation', async () => {
      tx.reservation.findFirst.mockResolvedValue(null);
      await expect(service.generateCard(TENANT_ID, RESERVATION_ID, ACTOR_ID)).rejects.toThrow(NotFoundException);
    });

    it('rejects a reservation that is not checked_in', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservationForCard({ status: 'confirmed' }));
      await expect(service.generateCard(TENANT_ID, RESERVATION_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('generates for a checked_in reservation', async () => {
      const card = await service.generateCard(TENANT_ID, RESERVATION_ID, ACTOR_ID);
      expect(card).toBeDefined();
      expect(tx.registrationCard.create).toHaveBeenCalled();
    });
  });

  describe('signCard', () => {
    it('404s on a missing card', async () => {
      tx.registrationCard.findFirst.mockResolvedValue(null);
      await expect(service.signCard(TENANT_ID, 'card-1', { signatureData: SIGNATURE_PNG }, ACTOR_ID)).rejects.toThrow(NotFoundException);
    });

    it('captures signatureData, signedAt, and witnessedBy', async () => {
      tx.registrationCard.findFirst.mockResolvedValue({ id: 'card-1', signedAt: null, branchId: BRANCH_ID, reservationId: RESERVATION_ID });
      await service.signCard(TENANT_ID, 'card-1', { signatureData: SIGNATURE_PNG }, ACTOR_ID);
      expect(tx.registrationCard.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ signatureData: SIGNATURE_PNG, signedAt: expect.any(Date), witnessedBy: ACTOR_ID }) }),
      );
    });

    it('rejects signing an already-signed card — a legal document, not a silently overwritable field', async () => {
      tx.registrationCard.findFirst.mockResolvedValue({ id: 'card-1', signedAt: new Date(), branchId: BRANCH_ID, reservationId: RESERVATION_ID });
      await expect(service.signCard(TENANT_ID, 'card-1', { signatureData: SIGNATURE_PNG }, ACTOR_ID)).rejects.toThrow(ConflictException);
      expect(tx.registrationCard.update).not.toHaveBeenCalled();
    });

    it('generates and encrypts a PDF, persisting the storage URL as documentUrl', async () => {
      tx.registrationCard.findFirst.mockResolvedValue({ id: 'card-1', signedAt: null, branchId: BRANCH_ID, reservationId: RESERVATION_ID });
      const card = await service.signCard(TENANT_ID, 'card-1', { signatureData: SIGNATURE_PNG }, ACTOR_ID);

      expect(documentStorage.write).toHaveBeenCalledTimes(1);
      const [key, bytes] = documentStorage.write.mock.calls[0];
      expect(key).toContain(TENANT_ID);
      expect(key).toContain('card-1');
      expect(Buffer.isBuffer(bytes)).toBe(true);
      expect(card.documentUrl).toBe('file:///fake/card.pdf.enc');
    });
  });

  describe('getCardPdf', () => {
    it('renders a live PDF preview for an unsigned card (no documentUrl yet)', async () => {
      tx.registrationCard.findFirst.mockResolvedValue({ id: 'card-1', documentUrl: null, fields: CARD_FIELDS, signatureData: null, signedAt: null });
      const pdf = await service.getCardPdf(TENANT_ID, 'card-1');
      expect(Buffer.isBuffer(pdf)).toBe(true);
      expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
      expect(documentStorage.read).not.toHaveBeenCalled();
    });

    it('reads and decrypts the persisted PDF for a signed card', async () => {
      const encryption = new EncryptionService();
      const realPdf = Buffer.from('%PDF-1.4 fake but good enough for this test');
      documentStorage.read.mockResolvedValue(encryption.encryptBuffer(realPdf));
      tx.registrationCard.findFirst.mockResolvedValue({ id: 'card-1', documentUrl: 'file:///fake/card.pdf.enc', fields: CARD_FIELDS });

      const pdf = await service.getCardPdf(TENANT_ID, 'card-1');
      expect(documentStorage.read).toHaveBeenCalledWith('file:///fake/card.pdf.enc');
      expect(pdf.equals(realPdf)).toBe(true);
    });
  });

  describe('getCardForReservation', () => {
    it('returns null when no card has been generated yet — not an error', async () => {
      tx.registrationCard.findFirst.mockResolvedValue(null);
      const result = await service.getCardForReservation(TENANT_ID, RESERVATION_ID);
      expect(result).toBeNull();
    });
  });
});
