import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
    guestProfile: { findFirst: jest.fn().mockResolvedValue({ id: GUEST_ID }) },
    gdprRequest: {
      findFirst: jest.fn().mockResolvedValue(gdprRequest()),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(gdprRequest(data))),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(gdprRequest(data))),
      findMany: jest.fn().mockResolvedValue([]),
    },
    reservation: { findMany: jest.fn().mockResolvedValue([]) },
    folio: { findMany: jest.fn().mockResolvedValue([]) },
    communicationLog: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('GdprService', () => {
  let service: GdprService;
  let tx: ReturnType<typeof makeTx>;
  let guestsService: { getGuestDetail: jest.Mock };
  let encryption: { encryptBuffer: jest.Mock; decryptBuffer: jest.Mock };
  let documentStorage: { write: jest.Mock; read: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    guestsService = { getGuestDetail: jest.fn().mockResolvedValue({ id: GUEST_ID, name: 'Jane Doe' }) };
    encryption = {
      encryptBuffer: jest.fn().mockImplementation((b: Buffer) => Buffer.concat([Buffer.from('enc:'), b])),
      decryptBuffer: jest.fn().mockImplementation((b: Buffer) => b.subarray(4)),
    };
    documentStorage = { write: jest.fn().mockResolvedValue('storage://export.enc'), read: jest.fn().mockResolvedValue(Buffer.from('enc:{"ok":true}')) };

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
});
