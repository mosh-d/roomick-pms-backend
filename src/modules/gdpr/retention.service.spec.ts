import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DOCUMENT_STORAGE_ADAPTER } from '../../common/documents/document-storage.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { RETENTION_REMOVED_NAME, RetentionService, cutoffFor } from './retention.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function makeTx() {
  return {
    tenant: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ documentRetentionMonths: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    registrationCard: { count: jest.fn().mockResolvedValue(3), findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    guestProfile: { count: jest.fn().mockResolvedValue(2), findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('RetentionService', () => {
  let service: RetentionService;
  let tx: ReturnType<typeof makeTx>;
  let prisma: { tenant: { findUniqueOrThrow: jest.Mock; findMany: jest.Mock }; withTenant: jest.Mock };
  let storage: { remove: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    prisma = {
      tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ documentRetentionMonths: 24 }), findMany: jest.fn().mockResolvedValue([{ id: TENANT_ID }]) },
      withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)),
    };
    storage = { remove: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [RetentionService, { provide: PrismaService, useValue: prisma }, { provide: DOCUMENT_STORAGE_ADAPTER, useValue: storage }],
    }).compile();
    service = moduleRef.get(RetentionService);
  });

  it('reaches back whole calendar months from today', () => {
    expect(cutoffFor(24, new Date('2026-10-07T15:00:00Z')).toISOString()).toBe('2024-10-07T00:00:00.000Z');
    expect(cutoffFor(6, new Date('2026-03-31T01:00:00Z')).toISOString().slice(0, 7)).toBe('2025-10');
  });

  it('keeps everything until a period is chosen — and then says what is past it', async () => {
    prisma.tenant.findUniqueOrThrow.mockResolvedValue({ documentRetentionMonths: null });
    await expect(service.status(TENANT_ID)).resolves.toEqual({ months: null, due: { registrationCards: 0, idDocuments: 0 } });
    await expect(service.status(TENANT_ID, 12)).resolves.toEqual({ months: 12, due: { registrationCards: 3, idDocuments: 2 } });
  });

  it('takes a period from 6 to 240 whole months, or none', async () => {
    await expect(service.setPeriod(TENANT_ID, 3, 'actor')).rejects.toThrow(BadRequestException);
    await expect(service.setPeriod(TENANT_ID, 241, 'actor')).rejects.toThrow(BadRequestException);
    await expect(service.setPeriod(TENANT_ID, 12.5, 'actor')).rejects.toThrow(BadRequestException);
    expect(tx.tenant.update).not.toHaveBeenCalled();
    await service.setPeriod(TENANT_ID, null, 'actor');
    expect(tx.tenant.update).toHaveBeenCalledWith({ where: { id: TENANT_ID }, data: { documentRetentionMonths: null } });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'retention.period_set', after: { months: null } }) }));
  });

  it('does nothing for a tenant keeping everything', async () => {
    prisma.tenant.findUniqueOrThrow.mockResolvedValue({ documentRetentionMonths: null });
    await expect(service.purgeTenant(TENANT_ID, null)).resolves.toEqual({ registrationCards: 0, idDocuments: 0, filesDeleted: 0 });
    expect(tx.registrationCard.findMany).not.toHaveBeenCalled();
  });

  it('removes the guest from old cards but keeps the stay; clears old ID documents; deletes files after the commit', async () => {
    const order: string[] = [];
    prisma.withTenant.mockImplementation(async (_t: string, fn: (x: unknown) => unknown) => {
      const result = await fn(tx);
      order.push('commit');
      return result;
    });
    storage.remove.mockImplementation((url: string) => {
      order.push(`remove ${url}`);
      return Promise.resolve();
    });
    tx.registrationCard.findMany.mockResolvedValueOnce([
      { id: 'card-1', documentUrl: 'docs/card-1.pdf', fields: { guestName: 'Ada', guestEmail: 'a@x', guestPhone: '+234', roomNumber: '101', confirmationNumber: 'RES-1' } },
    ]);
    tx.guestProfile.findMany.mockResolvedValueOnce([{ id: 'guest-1', idDocUrl: 'docs/id-1.enc' }]);

    const run = await service.purgeTenant(TENANT_ID, null);

    expect(run).toEqual({ registrationCards: 1, idDocuments: 1, filesDeleted: 2 });
    expect(tx.registrationCard.update).toHaveBeenCalledWith({
      where: { id: 'card-1' },
      data: {
        fields: { guestName: RETENTION_REMOVED_NAME, guestEmail: null, guestPhone: null, roomNumber: '101', confirmationNumber: 'RES-1' },
        signatureData: null,
        documentUrl: null,
        purgedAt: expect.any(Date),
      },
    });
    expect(tx.guestProfile.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['guest-1'] } },
      data: { idDocType: null, idDocNumber: null, idDocUrl: null, idDocExpiryDate: null },
    });
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('remove docs/card-1.pdf'));
    // Counts only in the audit trail.
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'retention.purged', after: { months: 24, registrationCards: 1, idDocuments: 1, filesDeleted: 2 } }) }),
    );
  });

  it('only looks at stays that have ended — never one booked or in the house', async () => {
    await service.purgeTenant(TENANT_ID, null);
    const where = (tx.registrationCard.findMany.mock.calls[0][0] as { where: { reservation: { status: { notIn: string[] } } } }).where;
    expect(where.reservation.status.notIn).toEqual(['confirmed', 'checked_in']);
    const guestWhere = (tx.guestProfile.findMany.mock.calls[0][0] as { where: { reservations: { none: { OR: unknown[] } } } }).where;
    expect(guestWhere.reservations.none.OR).toEqual([{ status: { in: ['confirmed', 'checked_in'] } }, { checkOutDate: { gte: expect.any(Date) } }]);
  });

  it('keeps going for other tenants when one fails', async () => {
    prisma.tenant.findMany.mockResolvedValue([{ id: 'bad' }, { id: TENANT_ID }]);
    prisma.tenant.findUniqueOrThrow.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ documentRetentionMonths: 24 });
    tx.registrationCard.findMany.mockResolvedValueOnce([{ id: 'card-1', documentUrl: null, fields: {} }]);
    await expect(service.purgeAll()).resolves.toEqual({ registrationCards: 1, idDocuments: 0, filesDeleted: 0 });
  });
});
