import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { DOCUMENT_STORAGE_ADAPTER } from '../../common/documents/document-storage.interface';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GuestsService } from '../guests/guests.service';
import { GdprService } from './gdpr.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const GUEST_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';

function gdprRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: REQUEST_ID,
    tenantId: TENANT_ID,
    guestId: GUEST_ID,
    type: 'access',
    status: 'pending',
    requestedBy: 'guest@example.com',
    requestedAt: new Date('2026-08-01T00:00:00.000Z'),
    deadline: new Date('2026-08-31T00:00:00.000Z'),
    completedAt: null,
    exportUrl: null,
    notes: null,
    ...overrides,
  };
}

function makeTx() {
  return {
    guestProfile: { findFirst: jest.fn().mockResolvedValue({ id: GUEST_ID }), update: jest.fn().mockResolvedValue({}) },
    gdprRequest: {
      findFirst: jest.fn().mockResolvedValue(gdprRequest()),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(gdprRequest(data))),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(gdprRequest(data))),
      findMany: jest.fn().mockResolvedValue([]),
    },
    reservation: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    folio: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    communicationLog: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    registrationCard: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    guestNote: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    webhookDelivery: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
    lineItem: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal('64500') } }) },
    payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal('64500') } }) },
    auditLog: { create: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
  };
}

describe('GdprService', () => {
  let service: GdprService;
  let tx: ReturnType<typeof makeTx>;
  let guestsService: { getGuestDetail: jest.Mock };
  let encryption: { encryptBuffer: jest.Mock; decryptBuffer: jest.Mock };
  let documentStorage: { write: jest.Mock; read: jest.Mock; remove: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    guestsService = { getGuestDetail: jest.fn().mockResolvedValue({ id: GUEST_ID, name: 'Jane Doe' }) };
    encryption = {
      encryptBuffer: jest.fn().mockImplementation((b: Buffer) => Buffer.concat([Buffer.from('enc:'), b])),
      decryptBuffer: jest.fn().mockImplementation((b: Buffer) => b.subarray(4)),
    };
    documentStorage = {
      write: jest.fn().mockResolvedValue('storage://export.enc'),
      read: jest.fn().mockResolvedValue(Buffer.from('enc:{"ok":true}')),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GdprService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: GuestsService, useValue: guestsService },
        { provide: EncryptionService, useValue: encryption },
        { provide: DOCUMENT_STORAGE_ADAPTER, useValue: documentStorage },
      ],
    }).compile();
    service = moduleRef.get(GdprService);
  });

  describe('createDataRequest', () => {
    const dto = { guestId: GUEST_ID, type: 'access' as const, requestedBy: 'guest@example.com' };

    it('rejects an unknown guest', async () => {
      tx.guestProfile.findFirst.mockResolvedValue(null);
      await expect(service.createDataRequest(TENANT_ID, dto, ACTOR_ID)).rejects.toThrow(NotFoundException);
    });

    it('sets deadline to 30 days from now', async () => {
      const before = Date.now();
      await service.createDataRequest(TENANT_ID, dto, ACTOR_ID);
      const created = tx.gdprRequest.create.mock.calls[0][0].data;
      const daysDiff = (created.deadline.getTime() - before) / 86_400_000;
      expect(daysDiff).toBeGreaterThan(29.9);
      expect(daysDiff).toBeLessThan(30.1);
    });

    it('folds verificationMethod into notes when given', async () => {
      await service.createDataRequest(TENANT_ID, { ...dto, verificationMethod: 'ID on file' }, ACTOR_ID);
      expect(tx.gdprRequest.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ notes: 'Verification: ID on file' }) }));
    });

    it('leaves notes null when no verificationMethod is given', async () => {
      await service.createDataRequest(TENANT_ID, dto, ACTOR_ID);
      expect(tx.gdprRequest.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ notes: null }) }));
    });

    it('writes an audit log naming the type and guest', async () => {
      await service.createDataRequest(TENANT_ID, dto, ACTOR_ID);
      expect(tx.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'gdpr.request_created', after: { type: 'access', guestId: GUEST_ID } }) }),
      );
    });
  });

  describe('updateStatus', () => {
    it('404s on a missing request', async () => {
      tx.gdprRequest.findFirst.mockResolvedValue(null);
      await expect(service.updateStatus(TENANT_ID, REQUEST_ID, { status: 'in_progress' }, ACTOR_ID)).rejects.toThrow(NotFoundException);
    });

    it.each(['completed', 'rejected'])('rejects further changes once a request is already %s', async (status) => {
      tx.gdprRequest.findFirst.mockResolvedValue(gdprRequest({ status }));
      await expect(service.updateStatus(TENANT_ID, REQUEST_ID, { status: 'in_progress' }, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('sets completedAt only when the new status is completed', async () => {
      const result = await service.updateStatus(TENANT_ID, REQUEST_ID, { status: 'completed' }, ACTOR_ID);
      expect(tx.gdprRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'completed', completedAt: expect.any(Date) }) }));
      expect(result).toBeDefined();
    });

    it('does not set completedAt for a non-terminal transition', async () => {
      await service.updateStatus(TENANT_ID, REQUEST_ID, { status: 'in_progress' }, ACTOR_ID);
      const data = tx.gdprRequest.update.mock.calls[0][0].data;
      expect(data.completedAt).toBeUndefined();
    });

    it('keeps the existing notes when none are given', async () => {
      tx.gdprRequest.findFirst.mockResolvedValue(gdprRequest({ notes: 'existing note' }));
      await service.updateStatus(TENANT_ID, REQUEST_ID, { status: 'in_progress' }, ACTOR_ID);
      expect(tx.gdprRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ notes: 'existing note' }) }));
    });
  });

  describe('downloadExport', () => {
    it('404s on a missing request', async () => {
      tx.gdprRequest.findFirst.mockResolvedValue(null);
      await expect(service.downloadExport(TENANT_ID, REQUEST_ID, ACTOR_ID)).rejects.toThrow(NotFoundException);
    });

    it('rejects an erasure request — nothing to export', async () => {
      tx.gdprRequest.findFirst.mockResolvedValue(gdprRequest({ type: 'erasure' }));
      await expect(service.downloadExport(TENANT_ID, REQUEST_ID, ACTOR_ID)).rejects.toThrow(BadRequestException);
    });

    it('generates the export on first call — writes storage, marks completed, audits', async () => {
      const result = await service.downloadExport(TENANT_ID, REQUEST_ID, ACTOR_ID);
      expect(guestsService.getGuestDetail).toHaveBeenCalledWith(TENANT_ID, GUEST_ID, true);
      expect(documentStorage.write).toHaveBeenCalledWith(`${TENANT_ID}/gdpr-exports/${REQUEST_ID}.enc`, expect.any(Buffer));
      expect(tx.gdprRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'completed', exportUrl: 'storage://export.enc' }) }),
      );
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'gdpr.data_exported' }) }));
      expect(result.toString('utf-8')).toBe('{"ok":true}');
    });

    it('does NOT regenerate on a second call — reads the already-stored file instead', async () => {
      tx.gdprRequest.findFirst.mockResolvedValue(gdprRequest({ exportUrl: 'storage://already-there.enc' }));
      await service.downloadExport(TENANT_ID, REQUEST_ID, ACTOR_ID);
      expect(documentStorage.write).not.toHaveBeenCalled();
      expect(documentStorage.read).toHaveBeenCalledWith('storage://already-there.enc');
      expect(tx.gdprRequest.update).not.toHaveBeenCalled();
    });
  });

  describe('eraseGuestData', () => {
    const guest = () => ({ id: GUEST_ID, name: 'Jane Doe', email: 'jane@example.com', idDocUrl: 'file:///docs/id.enc', deletedAt: null, marketingUnsubscribedAt: null });

    beforeEach(() => {
      tx.gdprRequest.findFirst.mockResolvedValue(gdprRequest({ type: 'erasure' }));
      tx.guestProfile.findFirst.mockResolvedValue(guest());
      tx.folio.findMany.mockResolvedValue([{ id: 'folio-1' }]);
      tx.registrationCard.findMany.mockResolvedValue([
        { id: 'card-1', fields: { guestName: 'Jane Doe', guestPhone: '+2348012345678', roomNumber: '101' }, documentUrl: 'file:///docs/card.enc' },
      ]);
    });

    it('takes the identity off the guest and their cards, keeps the stays and bills, and completes the request', async () => {
      const result = await service.eraseGuestData(TENANT_ID, REQUEST_ID, ACTOR_ID);

      const profile = (tx.guestProfile.update.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
      expect(profile).toMatchObject({ name: 'Erased guest', email: null, phone: null, idDocNumber: null, idDocUrl: null, tags: [], marketingOptIn: false });
      expect(profile.deletedAt).toBeInstanceOf(Date);

      const card = (tx.registrationCard.update.mock.calls[0] as [{ data: { fields: Record<string, unknown>; signatureData: null; documentUrl: null } }])[0].data;
      expect(card.fields).toEqual({ guestName: 'Erased guest', guestEmail: null, guestPhone: null, roomNumber: '101' });
      expect(card).toMatchObject({ signatureData: null, documentUrl: null });

      expect(tx.communicationLog.updateMany).toHaveBeenCalledWith({ where: { guestId: GUEST_ID }, data: { body: '[erased]', bodyHtml: null } });
      expect(tx.guestNote.updateMany).toHaveBeenCalledWith({ where: { guestId: GUEST_ID }, data: { body: '[erased]' } });
      // webhook deliveries that carried the guest are gone too
      expect(tx.webhookDelivery.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { payload: { path: ['data', 'reservation', 'guest', 'id'], equals: GUEST_ID } },
            { payload: { path: ['data', 'guest', 'id'], equals: GUEST_ID } },
          ],
        },
      });
      // payer details only where they were the guest's own
      expect(tx.folio.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['folio-1'] }, payerName: { equals: 'Jane Doe', mode: 'insensitive' } }, data: { payerName: 'Erased guest' } });

      expect(tx.gdprRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'completed' }) }));
      expect(result).toMatchObject({ status: 'completed' });
      // the stored ID photo and card PDF are deleted — after the database work
      expect(documentStorage.remove.mock.calls.map((c) => c[0])).toEqual(['file:///docs/id.enc', 'file:///docs/card.enc']);
    });

    it('audits counts, never the erased details themselves', async () => {
      await service.eraseGuestData(TENANT_ID, REQUEST_ID, ACTOR_ID);
      const entry = (tx.auditLog.create.mock.calls[0] as [{ data: { action: string; after: Record<string, unknown> } }])[0].data;
      expect(entry.action).toBe('gdpr.guest_erased');
      expect(JSON.stringify(entry.after)).not.toMatch(/Jane|jane@|2348012345678/);
    });

    it("scrubs what the audit trail recorded of the guest's details — the rows stay, their values go", async () => {
      await service.eraseGuestData(TENANT_ID, REQUEST_ID, ACTOR_ID);
      expect(tx.auditLog.updateMany).toHaveBeenCalledWith({
        where: { entityType: 'guest_profile', entityId: GUEST_ID },
        data: { before: Prisma.DbNull, after: { erased: true } },
      });
      const entry = (tx.auditLog.create.mock.calls[0] as [{ data: { after: Record<string, unknown> } }])[0].data;
      expect(entry.after.auditRows).toBe(3);
    });

    it('refuses while a stay is booked or in progress', async () => {
      tx.reservation.count.mockResolvedValue(1);
      await expect(service.eraseGuestData(TENANT_ID, REQUEST_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
      expect(tx.guestProfile.update).not.toHaveBeenCalled();
    });

    it('refuses while the guest still owes money — the details are needed to collect it', async () => {
      tx.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('50000') } });
      await expect(service.eraseGuestData(TENANT_ID, REQUEST_ID, ACTOR_ID)).rejects.toThrow(/still owes 14500\.00/);
      expect(tx.guestProfile.update).not.toHaveBeenCalled();
    });

    it('only erases from an erasure request, once', async () => {
      tx.gdprRequest.findFirst.mockResolvedValueOnce(gdprRequest({ type: 'access' }));
      await expect(service.eraseGuestData(TENANT_ID, REQUEST_ID, ACTOR_ID)).rejects.toThrow(BadRequestException);
      tx.guestProfile.findFirst.mockResolvedValueOnce({ ...guest(), deletedAt: new Date() });
      await expect(service.eraseGuestData(TENANT_ID, REQUEST_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
      expect(documentStorage.remove).not.toHaveBeenCalled();
    });
  });
});
