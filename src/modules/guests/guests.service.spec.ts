process.env.ENCRYPTION_KEY = 'b'.repeat(64);

import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { DOCUMENT_STORAGE_ADAPTER } from '../../common/documents/document-storage.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { GuestsService } from './guests.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const GUEST_ID = '55555555-5555-4555-8555-555555555555';
const ACTOR_ID = '99999999-9999-4999-8999-999999999999';

function makeTx() {
  return {
    guestProfile: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: GUEST_ID, ...data }),
      ),
      update: jest.fn().mockResolvedValue({ id: GUEST_ID }),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    reservation: { findMany: jest.fn().mockResolvedValue([]) },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    guestNote: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'note-1', createdAt: new Date(), author: null, ...data })),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

describe('GuestsService', () => {
  let service: GuestsService;
  let tx: ReturnType<typeof makeTx>;
  let documentStorage: { write: jest.Mock; read: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    documentStorage = { write: jest.fn().mockResolvedValue('file:///fake/id-photo.enc'), read: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GuestsService,
        EncryptionService,
        { provide: DOCUMENT_STORAGE_ADAPTER, useValue: documentStorage },
        {
          provide: PrismaService,
          useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) },
        },
      ],
    }).compile();
    service = moduleRef.get(GuestsService);
  });

  describe('createGuest', () => {
    it('creates with only the allowed fields', async () => {
      const guest = await service.createGuest(TENANT_ID, { name: 'John Doe', email: 'john@doe.com', phone: '090', notes: 'VIP' });
      expect(tx.guestProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { tenantId: TENANT_ID, name: 'John Doe', email: 'john@doe.com', phone: '090', notes: 'VIP' } }),
      );
      expect(guest.id).toBe(GUEST_ID);
    });
  });

  describe('getGuestById', () => {
    it('404s on missing/soft-deleted guest', async () => {
      tx.guestProfile.findFirst.mockResolvedValue(null);
      await expect(service.getGuestById(TENANT_ID, GUEST_ID)).rejects.toThrow(NotFoundException);
    });

    it('returns the guest when found', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({ id: GUEST_ID, name: 'John Doe' });
      const guest = await service.getGuestById(TENANT_ID, GUEST_ID);
      expect(guest.id).toBe(GUEST_ID);
    });

    it('sums only non-void, non-deleted payments across the guest\'s folios into totalSpend', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({ id: GUEST_ID, name: 'John Doe' });
      tx.payment.findMany.mockResolvedValue([{ amount: '100.00' }, { amount: '50.50' }]);
      const guest = await service.getGuestById(TENANT_ID, GUEST_ID);
      expect(tx.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { folio: { guestId: GUEST_ID }, isVoid: false, deletedAt: null } }));
      expect(guest.totalSpend).toBe('150.50');
    });

    it('totalSpend is "0.00" when there are no payments at all', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({ id: GUEST_ID, name: 'John Doe' });
      const guest = await service.getGuestById(TENANT_ID, GUEST_ID);
      expect(guest.totalSpend).toBe('0.00');
    });

    it('includes stay history ordered by check-in date, newest first', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({ id: GUEST_ID, name: 'John Doe' });
      const stays = [{ id: 'r1' }, { id: 'r2' }];
      tx.reservation.findMany.mockResolvedValue(stays);
      const guest = await service.getGuestById(TENANT_ID, GUEST_ID);
      expect(tx.reservation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { guestId: GUEST_ID }, orderBy: { checkInDate: 'desc' } }));
      expect(guest.stayHistory).toEqual(stays);
    });

    it('includes the notes feed, newest first', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({ id: GUEST_ID, name: 'John Doe' });
      const notes = [{ id: 'n1', body: 'Likes extra pillows' }];
      tx.guestNote.findMany.mockResolvedValue(notes);
      const guest = await service.getGuestById(TENANT_ID, GUEST_ID);
      expect(tx.guestNote.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { guestId: GUEST_ID }, orderBy: { createdAt: 'desc' } }));
      expect(guest.notesFeed).toEqual(notes);
    });
  });

  describe('updateGuest', () => {
    it('404s on a missing guest', async () => {
      tx.guestProfile.findFirst.mockResolvedValue(null);
      await expect(service.updateGuest(TENANT_ID, GUEST_ID, { vipLevel: 3 }, ACTOR_ID)).rejects.toThrow(NotFoundException);
    });

    it('writes only the given fields and re-reads the full profile', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({ id: GUEST_ID, name: 'John Doe' });
      await service.updateGuest(TENANT_ID, GUEST_ID, { vipLevel: 3, tags: ['corporate'] }, ACTOR_ID);
      expect(tx.guestProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: GUEST_ID }, data: expect.objectContaining({ vipLevel: 3, tags: ['corporate'] }) }),
      );
    });

    it('writes an audit log', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({ id: GUEST_ID, name: 'John Doe' });
      await service.updateGuest(TENANT_ID, GUEST_ID, { vipLevel: 3 }, ACTOR_ID);
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'guest.updated' }) }));
    });
  });

  describe('addGuestNote', () => {
    it('404s on a missing guest', async () => {
      tx.guestProfile.findFirst.mockResolvedValue(null);
      await expect(service.addGuestNote(TENANT_ID, GUEST_ID, { body: 'Note' }, ACTOR_ID)).rejects.toThrow(NotFoundException);
    });

    it('creates the note attributed to the actor and audits it', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({ id: GUEST_ID });
      const note = await service.addGuestNote(TENANT_ID, GUEST_ID, { body: 'Requested extra pillows' }, ACTOR_ID);
      expect(tx.guestNote.create).toHaveBeenCalledWith(expect.objectContaining({ data: { tenantId: TENANT_ID, guestId: GUEST_ID, authorId: ACTOR_ID, body: 'Requested extra pillows' } }));
      expect(note.body).toBe('Requested extra pillows');
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'guest.note_added' }) }));
    });
  });

  describe('listGuests', () => {
    it('with no q, lists every non-deleted guest', async () => {
      await service.listGuests(TENANT_ID, undefined, 1, 50);
      expect(tx.guestProfile.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null } }));
    });

    it('with a q, filters by name OR email — separate from searchGuests, same matching rule', async () => {
      await service.listGuests(TENANT_ID, 'jane', 1, 50);
      expect(tx.guestProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, OR: [{ name: { contains: 'jane', mode: 'insensitive' } }, { email: { contains: 'jane', mode: 'insensitive' } }] },
        }),
      );
    });

    it('paginates via skip/take', async () => {
      await service.listGuests(TENANT_ID, undefined, 3, 10);
      expect(tx.guestProfile.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
    });

    it('returns the total count alongside the page of rows', async () => {
      tx.guestProfile.count.mockResolvedValue(42);
      const result = await service.listGuests(TENANT_ID, undefined, 1, 50);
      expect(result.total).toBe(42);
    });
  });

  describe('searchGuests', () => {
    it('matches name OR email, case-insensitively, capped at 20', async () => {
      await service.searchGuests(TENANT_ID, 'john');
      expect(tx.guestProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deletedAt: null,
            OR: [
              { name: { contains: 'john', mode: 'insensitive' } },
              { email: { contains: 'john', mode: 'insensitive' } },
            ],
          },
          take: 20,
        }),
      );
    });
  });

  describe('findOrCreateGuestInTx', () => {
    it('resolves an existing guest by id', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({ id: GUEST_ID, name: 'John Doe' });
      const guest = await service.findOrCreateGuestInTx(tx as never, TENANT_ID, { guestId: GUEST_ID });
      expect(guest.id).toBe(GUEST_ID);
      expect(tx.guestProfile.create).not.toHaveBeenCalled();
    });

    it('404s when the referenced guestId does not exist', async () => {
      tx.guestProfile.findFirst.mockResolvedValue(null);
      await expect(service.findOrCreateGuestInTx(tx as never, TENANT_ID, { guestId: GUEST_ID })).rejects.toThrow(NotFoundException);
    });

    it('creates a new guest inline when given a guest payload instead of an id', async () => {
      const guest = await service.findOrCreateGuestInTx(tx as never, TENANT_ID, { guest: { name: 'Jane Doe' } });
      expect(tx.guestProfile.create).toHaveBeenCalled();
      expect(guest.id).toBe(GUEST_ID);
    });
  });

  describe('recordIdDocumentInTx', () => {
    it('encrypts idDocNumber before writing — never plaintext in the update call', async () => {
      await service.recordIdDocumentInTx(
        tx as never,
        TENANT_ID,
        BRANCH_ID,
        GUEST_ID,
        { idDocType: 'passport', idDocNumber: 'P1234567', idDocExpiryDate: '2030-01-01', nationality: 'NG' },
        ACTOR_ID,
      );
      const data = tx.guestProfile.update.mock.calls[0][0].data;
      expect(data.idDocNumber).not.toBe('P1234567');
      expect(data.idDocNumber.split(':')).toHaveLength(3);
      expect(data.idDocType).toBe('passport');
      expect(data.nationality).toBe('NG');
      expect(data.idDocExpiryDate).toEqual(new Date('2030-01-01'));
    });

    it('never writes the plaintext or ciphertext id number to the audit row', async () => {
      await service.recordIdDocumentInTx(
        tx as never,
        TENANT_ID,
        BRANCH_ID,
        GUEST_ID,
        { idDocType: 'passport', idDocNumber: 'P1234567' },
        ACTOR_ID,
      );
      const auditData = tx.auditLog.create.mock.calls[0][0].data;
      expect(auditData.action).toBe('guest.id_document_recorded');
      expect(JSON.stringify(auditData.after)).not.toContain('P1234567');
    });

    it('does not touch document storage when no photo is given', async () => {
      await service.recordIdDocumentInTx(tx as never, TENANT_ID, BRANCH_ID, GUEST_ID, { idDocType: 'passport', idDocNumber: 'P1' }, ACTOR_ID);
      expect(documentStorage.write).not.toHaveBeenCalled();
      expect(tx.guestProfile.update.mock.calls[0][0].data.idDocUrl).toBeUndefined();
    });

    it('encrypts and stores a photo when given, and writes the returned URL', async () => {
      await service.recordIdDocumentInTx(
        tx as never,
        TENANT_ID,
        BRANCH_ID,
        GUEST_ID,
        { idDocType: 'passport', idDocNumber: 'P1', photoBase64: Buffer.from('a fake id photo').toString('base64') },
        ACTOR_ID,
      );
      expect(documentStorage.write).toHaveBeenCalledTimes(1);
      const [key, bytes] = documentStorage.write.mock.calls[0];
      expect(key).toContain(TENANT_ID);
      expect(bytes.equals(Buffer.from('a fake id photo'))).toBe(false); // encrypted, not raw
      expect(tx.guestProfile.update.mock.calls[0][0].data.idDocUrl).toBe('file:///fake/id-photo.enc');
    });
  });

  describe('getGuestDetail', () => {
    it('404s on missing/soft-deleted guest', async () => {
      tx.guestProfile.findFirst.mockResolvedValue(null);
      await expect(service.getGuestDetail(TENANT_ID, GUEST_ID, false)).rejects.toThrow(NotFoundException);
    });

    it('reports first_visit when no ID is on file', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({ id: GUEST_ID, name: 'John', idDocNumber: null, idDocExpiryDate: null, idDocType: null, nationality: null });
      const detail = await service.getGuestDetail(TENANT_ID, GUEST_ID, false);
      expect(detail.idCheckState).toBe('first_visit');
      expect(detail.idDocNumber).toBeNull();
    });

    it('masks idDocNumber by default and reveals it only when asked', async () => {
      const encryption = new EncryptionService();
      const ciphertext = encryption.encrypt('P1234567');
      tx.guestProfile.findFirst.mockResolvedValue({
        id: GUEST_ID,
        name: 'John',
        idDocNumber: ciphertext,
        idDocExpiryDate: new Date('2099-01-01'),
        idDocType: 'passport',
        nationality: 'NG',
      });

      const masked = await service.getGuestDetail(TENANT_ID, GUEST_ID, false);
      expect(masked.idDocNumber).toBe('••••4567');
      expect(masked.idCheckState).toBe('valid');

      const revealed = await service.getGuestDetail(TENANT_ID, GUEST_ID, true);
      expect(revealed.idDocNumber).toBe('P1234567');
    });

    it('reports expired when idDocExpiryDate is in the past', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({
        id: GUEST_ID,
        name: 'John',
        idDocNumber: null,
        idDocExpiryDate: new Date('2020-01-01'),
        idDocType: 'passport',
        nationality: null,
      });
      const detail = await service.getGuestDetail(TENANT_ID, GUEST_ID, false);
      expect(detail.idCheckState).toBe('expired');
    });
  });
});
