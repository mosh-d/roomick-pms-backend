import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { TaxesService } from '../taxes/taxes.service';
import { FoliosService } from './folios.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const FOLIO_ID = '99999999-9999-4999-8999-999999999999';
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';

function folio(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: FOLIO_ID, tenantId: TENANT_ID, branchId: BRANCH_ID, reservationId: RESERVATION_ID, status: 'open', label: null, deletedAt: null, ...overrides };
}

function reservation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RESERVATION_ID,
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    guestId: 'guest-1',
    confirmedRate: new Prisma.Decimal('300'), // 3 nights x 100
    overrideRate: null,
    checkInDate: new Date('2026-09-01T00:00:00.000Z'),
    checkOutDate: new Date('2026-09-04T00:00:00.000Z'),
    roomType: { name: 'Deluxe Room' },
    ...overrides,
  };
}

function makeTx() {
  return {
    folio: { findFirst: jest.fn(), create: jest.fn().mockResolvedValue(folio()), update: jest.fn().mockResolvedValue(folio({ status: 'settled' })) },
    lineItem: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'li-1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    payment: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'pay-1' }) },
    folioTransfer: { create: jest.fn().mockResolvedValue({ id: 'transfer-1' }), findMany: jest.fn().mockResolvedValue([]) },
    taxRule: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('FoliosService', () => {
  let service: FoliosService;
  let tx: ReturnType<typeof makeTx>;
  let taxesService: { computeTaxesForCharge: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    taxesService = { computeTaxesForCharge: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        FoliosService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: PropertyService, useValue: { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, timezone: 'Africa/Lagos', currency: 'NGN' }) } },
        { provide: TaxesService, useValue: taxesService },
      ],
    }).compile();
    service = moduleRef.get(FoliosService);
  });

  describe('ensurePrimaryFolio', () => {
    it('returns the existing primary folio instead of creating a second one', async () => {
      tx.folio.findFirst.mockResolvedValue(folio());
      const result = await service.ensurePrimaryFolio(tx as never, reservation() as never, ACTOR_ID);
      expect(result.id).toBe(FOLIO_ID);
      expect(tx.folio.create).not.toHaveBeenCalled();
    });

    it('creates an open folio when none exists yet (covers reservations checked in before this module)', async () => {
      tx.folio.findFirst.mockResolvedValue(null);
      await service.ensurePrimaryFolio(tx as never, reservation() as never, ACTOR_ID);
      expect(tx.folio.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'open', reservationId: RESERVATION_ID }) }),
      );
    });
  });

  describe('postRoomChargeForDate — accrual', () => {
    it('derives one night from the stay total (confirmedRate / nights), not the room type base rate', async () => {
      await service.postRoomChargeForDate(tx as never, reservation() as never, folio() as never, new Date('2026-09-01T00:00:00.000Z'), 'Check-in', ACTOR_ID);
      expect(tx.lineItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ chargeType: 'room', amount: expect.objectContaining({ toFixed: expect.any(Function) }) }),
        }),
      );
      const created = tx.lineItem.create.mock.calls[0][0].data;
      expect(created.amount.toFixed(2)).toBe('100.00'); // 300 / 3 nights
    });

    it('prefers an absolute nightly overrideRate over the derived figure, so a discount applies every night', async () => {
      await service.postRoomChargeForDate(
        tx as never,
        reservation({ overrideRate: new Prisma.Decimal('80') }) as never,
        folio() as never,
        new Date('2026-09-01T00:00:00.000Z'),
        'Check-in',
        ACTOR_ID,
      );
      expect(tx.lineItem.create.mock.calls[0][0].data.amount.toFixed(2)).toBe('80.00');
    });

    it('REFUSES to double-post a night already billed — the guard that makes night audit safe to add', async () => {
      tx.lineItem.findFirst.mockResolvedValue({ id: 'existing-room-charge' });
      const result = await service.postRoomChargeForDate(tx as never, reservation() as never, folio() as never, new Date('2026-09-01T00:00:00.000Z'), 'Night Audit', ACTOR_ID);
      expect(result).toBeNull();
      expect(tx.lineItem.create).not.toHaveBeenCalled();
    });

    it('tags the description with its source so a system post is distinguishable from a hand post', async () => {
      await service.postRoomChargeForDate(tx as never, reservation() as never, folio() as never, new Date('2026-09-02T00:00:00.000Z'), 'Night Audit', ACTOR_ID);
      expect(tx.lineItem.create.mock.calls[0][0].data.description).toBe('Room Charge — Night Audit, 2026-09-02 (Deluxe Room)');
    });
  });

  describe('backfillRoomCharges — the check-out safety net', () => {
    it('posts every elapsed night, stopping before the departure day', async () => {
      // Stay 01→04 (3 nights), "today" is the 04th: nights 01, 02, 03 bill.
      const posted = await service.backfillRoomCharges(
        tx as never,
        reservation() as never,
        folio() as never,
        new Date('2026-09-04T00:00:00.000Z'),
        'Check-out',
        ACTOR_ID,
      );
      expect(posted).toBe(3);
      const dates = tx.lineItem.create.mock.calls.map((c) => c[0].data.serviceDate.toISOString().slice(0, 10));
      expect(dates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    });

    it('never bills nights that have not happened yet (early departure)', async () => {
      // Same stay, but the guest leaves on the 02nd — only the 01st is billable.
      const posted = await service.backfillRoomCharges(
        tx as never,
        reservation() as never,
        folio() as never,
        new Date('2026-09-02T00:00:00.000Z'),
        'Check-out',
        ACTOR_ID,
      );
      expect(posted).toBe(1);
    });

    it('skips nights already billed, so it is safe to run repeatedly', async () => {
      tx.lineItem.findFirst.mockResolvedValue({ id: 'already-billed' });
      const posted = await service.backfillRoomCharges(
        tx as never,
        reservation() as never,
        folio() as never,
        new Date('2026-09-04T00:00:00.000Z'),
        'Check-out',
        ACTOR_ID,
      );
      expect(posted).toBe(0);
      expect(tx.lineItem.create).not.toHaveBeenCalled();
    });
  });

  describe('postCharge — taxes as separate line items', () => {
    it('writes the parent charge plus one tax line item per matching rule', async () => {
      tx.folio.findFirst.mockResolvedValue(folio());
      taxesService.computeTaxesForCharge.mockResolvedValue([
        { ruleId: 'vat', ruleName: 'VAT', rate: new Prisma.Decimal('0.075'), taxAmount: new Prisma.Decimal('750') },
        { ruleId: 'svc', ruleName: 'Service Charge', rate: new Prisma.Decimal('0.1'), taxAmount: new Prisma.Decimal('1000') },
      ]);
      await service.postCharge(TENANT_ID, FOLIO_ID, { description: 'Dinner', amount: 10000, chargeType: 'fnb' }, ACTOR_ID);

      expect(tx.lineItem.create).toHaveBeenCalledTimes(3); // parent + 2 tax rows
      const parent = tx.lineItem.create.mock.calls[0][0].data;
      expect(parent.chargeType).toBe('fnb');
      // taxAmount on the parent is display-only; the ledger entries are the tax rows
      expect(parent.taxAmount.toFixed(2)).toBe('1750.00');
      const taxRows = tx.lineItem.create.mock.calls.slice(1).map((c) => c[0].data);
      expect(taxRows.every((r) => r.chargeType === 'tax')).toBe(true);
      expect(taxRows.map((r) => r.taxRuleIds)).toEqual([['vat'], ['svc']]);
    });

    it('rejects posting to a settled folio', async () => {
      tx.folio.findFirst.mockResolvedValue(folio({ status: 'settled' }));
      await expect(
        service.postCharge(TENANT_ID, FOLIO_ID, { description: 'Dinner', amount: 100, chargeType: 'fnb' }, ACTOR_ID),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('balance — computed, never stored', () => {
    beforeEach(() => tx.folio.findFirst.mockResolvedValue(folio()));

    it('balance = charges (incl. tax rows) minus payments', async () => {
      tx.lineItem.findMany.mockResolvedValue([
        { amount: new Prisma.Decimal('10000'), chargeType: 'fnb' },
        { amount: new Prisma.Decimal('750'), chargeType: 'tax' },
      ]);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('2000'), paymentPurpose: 'payment' }]);
      const result = await service.getFolio(TENANT_ID, FOLIO_ID);
      expect(result.totals.subTotal.toFixed(2)).toBe('10000.00');
      expect(result.totals.taxTotal.toFixed(2)).toBe('750.00');
      expect(result.totals.totalCost.toFixed(2)).toBe('10750.00');
      expect(result.totals.balanceDue.toFixed(2)).toBe('8750.00');
    });

    it('excludes voided and soft-deleted rows from the ledger query', async () => {
      await service.getFolio(TENANT_ID, FOLIO_ID);
      expect(tx.lineItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isVoid: false, deletedAt: null }) }),
      );
    });

    it('counts a deposit as a payment but never as a line item', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('500'), chargeType: 'room' }]);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('200'), paymentPurpose: 'deposit' }]);
      const result = await service.getFolio(TENANT_ID, FOLIO_ID);
      expect(result.totals.depositsTotal.toFixed(2)).toBe('200.00');
      expect(result.totals.subTotal.toFixed(2)).toBe('500.00');
      expect(result.totals.balanceDue.toFixed(2)).toBe('300.00');
    });

    it('a negative balance is a credit owed back to the guest', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('150'), paymentPurpose: 'payment' }]);
      const result = await service.getFolio(TENANT_ID, FOLIO_ID);
      expect(result.totals.balanceDue.toFixed(2)).toBe('-50.00');
    });
  });

  describe('correctLineItem — append-only', () => {
    it('appends a negating correction and never mutates the original', async () => {
      tx.lineItem.findFirst.mockResolvedValue({ id: 'li-original', folioId: FOLIO_ID, description: 'Minibar', amount: new Prisma.Decimal('5000'), serviceDate: new Date('2026-09-01') });
      tx.folio.findFirst.mockResolvedValue(folio());
      await service.correctLineItem(TENANT_ID, 'li-original', { reason: 'Guest disputed' }, ACTOR_ID);

      const created = tx.lineItem.create.mock.calls[0][0].data;
      expect(created.amount.toFixed(2)).toBe('-5000.00');
      expect(created.chargeType).toBe('correction');
      expect(created.description).toContain('Guest disputed');
      // The original row must be untouched — no update call anywhere.
      expect(tx.lineItem).not.toHaveProperty('update');
    });

    it('404s on a missing line item', async () => {
      tx.lineItem.findFirst.mockResolvedValue(null);
      await expect(service.correctLineItem(TENANT_ID, 'nope', { reason: 'x' }, ACTOR_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('splitFolio — moving charges between a reservation\'s folios', () => {
    const TARGET_ID = '88888888-8888-4888-8888-888888888888';
    const dto = { targetFolioId: TARGET_ID, lineItemIds: ['li-1', 'li-2'], reason: 'Room to company account' };

    beforeEach(() => {
      tx.folio.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === TARGET_ID ? folio({ id: TARGET_ID, label: 'Company' }) : folio()),
      );
      tx.lineItem.findMany.mockResolvedValue([
        { id: 'li-1', amount: new Prisma.Decimal('20000') },
        { id: 'li-2', amount: new Prisma.Decimal('1500') },
      ]);
    });

    it('reassigns the folio without touching any amount, and snapshots what moved', async () => {
      const transfer = await service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID);
      expect(tx.lineItem.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['li-1', 'li-2'] } },
        data: { folioId: TARGET_ID }, // folioId only — no amount in this update
      });
      expect(tx.folioTransfer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lineItemIds: ['li-1', 'li-2'], reason: dto.reason }),
        }),
      );
      expect(transfer).toBeDefined();
    });

    it('records the transfer amount as the sum of what moved (balance is conserved across the pair)', async () => {
      await service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID);
      expect(tx.folioTransfer.create.mock.calls[0][0].data.amount.toFixed(2)).toBe('21500.00');
    });

    it('rejects splitting a folio into itself', async () => {
      await expect(service.splitFolio(TENANT_ID, FOLIO_ID, { ...dto, targetFolioId: FOLIO_ID }, ACTOR_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a target folio on a different reservation — that is a transfer, not a split', async () => {
      tx.folio.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === TARGET_ID ? folio({ id: TARGET_ID, reservationId: 'other-reservation' }) : folio()),
      );
      await expect(service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID)).rejects.toThrow(BadRequestException);
      expect(tx.lineItem.updateMany).not.toHaveBeenCalled();
    });

    it('rejects line items that do not belong to the source folio', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ id: 'li-1', amount: new Prisma.Decimal('20000') }]); // only 1 of 2 found
      await expect(service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID)).rejects.toThrow(BadRequestException);
      expect(tx.lineItem.updateMany).not.toHaveBeenCalled();
    });

    it('rejects splitting out of a settled folio', async () => {
      tx.folio.findFirst.mockResolvedValue(folio({ status: 'settled' }));
      await expect(service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });
  });

  describe('closeFolio — the only FOLIO_NOT_SETTLED path', () => {
    beforeEach(() => tx.folio.findFirst.mockResolvedValue(folio()));

    it('rejects closing a folio that still owes', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      await expect(service.closeFolio(TENANT_ID, FOLIO_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('settles at a zero balance', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), paymentPurpose: 'payment' }]);
      await service.closeFolio(TENANT_ID, FOLIO_ID, ACTOR_ID);
      expect(tx.folio.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'settled' }) }),
      );
    });

    it('settles at a credit balance too', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('150'), paymentPurpose: 'payment' }]);
      await expect(service.closeFolio(TENANT_ID, FOLIO_ID, ACTOR_ID)).resolves.toBeDefined();
    });
  });

  describe('settleIfFullyPaid — the check-out path, which must never throw', () => {
    it('leaves the folio OPEN when a balance is outstanding, instead of throwing (City Ledger)', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      const settled = await service.settleIfFullyPaid(tx as never, folio() as never, ACTOR_ID);
      expect(settled).toBe(false);
      expect(tx.folio.update).not.toHaveBeenCalled();
    });

    it('settles when fully paid', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), paymentPurpose: 'payment' }]);
      const settled = await service.settleIfFullyPaid(tx as never, folio() as never, ACTOR_ID);
      expect(settled).toBe(true);
    });
  });
});
