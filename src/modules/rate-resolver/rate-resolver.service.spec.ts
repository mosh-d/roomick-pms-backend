import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { TaxesService } from '../taxes/taxes.service';
import { RateResolverService } from './rate-resolver.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const TYPE_ID = '88888888-8888-4888-8888-888888888888';

const ROOM_TYPE = { id: TYPE_ID, branchId: BRANCH_ID, baseRate: new Prisma.Decimal('100.00') };

function plan(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'plan-1',
    branchId: BRANCH_ID,
    roomTypeId: null,
    name: 'Test Plan',
    type: 'seasonal',
    amount: new Prisma.Decimal('10'),
    adjustmentType: 'fixed',
    cascadeTier: 2,
    isOverride: false,
    validFrom: null,
    validTo: null,
    minLOS: null,
    promoCode: null,
    isActive: true,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeTx() {
  return {
    ratePlan: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'new-plan', ...data })), update: jest.fn() },
    roomType: { findFirst: jest.fn().mockResolvedValue(ROOM_TYPE) },
    corporateAccount: { findFirst: jest.fn().mockResolvedValue(null) },
    rateAuditLog: {
      create: jest.fn().mockImplementation(() => Promise.resolve({ id: BigInt(++auditLogSeq) })),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

let auditLogSeq = 0;

describe('RateResolverService', () => {
  let service: RateResolverService;
  let tx: ReturnType<typeof makeTx>;
  let taxesService: { computeTaxesForCharge: jest.Mock };

  beforeEach(async () => {
    auditLogSeq = 0;
    tx = makeTx();
    taxesService = { computeTaxesForCharge: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        RateResolverService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: PropertyService, useValue: { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID }) } },
        { provide: TaxesService, useValue: taxesService },
      ],
    }).compile();
    service = moduleRef.get(RateResolverService);
  });

  describe('resolveStay — base case', () => {
    it('with no matching plans at all, every night resolves to the room type baseRate', async () => {
      const result = await service.resolveStay(
        tx as never,
        TENANT_ID,
        BRANCH_ID,
        ROOM_TYPE as never,
        new Date('2026-09-01'),
        new Date('2026-09-04'),
        {},
        { triggeredBy: 'booking_create' },
      );
      expect(result.subtotal.toFixed(2)).toBe('300.00'); // 100 × 3 nights
      expect(result.ruleApplied.type).toBe('base');
      expect(result.ratePlanId).toBeNull();
      expect(result.perNight).toHaveLength(3);
    });

    it('writes one RateAuditLog row per night', async () => {
      await service.resolveStay(tx as never, TENANT_ID, BRANCH_ID, ROOM_TYPE as never, new Date('2026-09-01'), new Date('2026-09-04'), {}, { triggeredBy: 'booking_create' });
      expect(tx.rateAuditLog.create).toHaveBeenCalledTimes(3);
      expect(tx.rateAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: TENANT_ID, branchId: BRANCH_ID, reservationId: null, triggeredBy: 'booking_create' }) }));
    });

    /**
     * `resolveStay` runs BEFORE a booking-create/walk-in reservation exists
     * (see `reservations.service.ts` — it needs the resolved rate to even
     * build the row), so these rows are written `reservationId: null` and
     * their ids handed back so the caller can backfill once the
     * reservation is real. Without this, the audit trail for the exact
     * calculation that set the price would be permanently unlinkable.
     */
    it('returns the created rows own ids as auditLogIds, one per night', async () => {
      const result = await service.resolveStay(tx as never, TENANT_ID, BRANCH_ID, ROOM_TYPE as never, new Date('2026-09-01'), new Date('2026-09-04'), {}, { triggeredBy: 'booking_create' });
      expect(result.auditLogIds).toHaveLength(3);
      expect(result.auditLogIds.every((id) => typeof id === 'bigint')).toBe(true);
    });

    it('a reservationId passed up front (e.g. modify) is written directly, no backfill needed', async () => {
      await service.resolveStay(tx as never, TENANT_ID, BRANCH_ID, ROOM_TYPE as never, new Date('2026-09-01'), new Date('2026-09-02'), {}, { triggeredBy: 'modify', reservationId: 'res-1' });
      expect(tx.rateAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reservationId: 'res-1' }) }));
    });
  });

  describe('linkAuditLogsToReservation', () => {
    it('backfills reservationId on exactly the given ids', async () => {
      await service.linkAuditLogsToReservation(tx as never, [1n, 2n], 'res-42');
      expect(tx.rateAuditLog.updateMany).toHaveBeenCalledWith({ where: { id: { in: [1n, 2n] } }, data: { reservationId: 'res-42' } });
    });

    it('is a no-op for an empty id list (a pure quote never creates a reservation)', async () => {
      await service.linkAuditLogsToReservation(tx as never, [], 'res-42');
      expect(tx.rateAuditLog.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('getAuditTrail', () => {
    /**
     * `RateAuditLog.id` is a BigInt (BIGSERIAL, same convention as
     * `NightAuditLog`) — `JSON.stringify` throws on a raw BigInt, which is
     * exactly what crashed this endpoint with a real 500 before this
     * fix (found live, not by inspection).
     */
    it('stringifies the BigInt id so the response can actually be JSON-serialized', async () => {
      tx.rateAuditLog.findMany.mockResolvedValue([{ id: 123n, reservationId: 'res-1', tenantId: TENANT_ID }]);
      const result = await service.getAuditTrail(TENANT_ID, 'res-1');
      expect(result[0].id).toBe('123');
      expect(typeof result[0].id).toBe('string');
      expect(() => JSON.stringify(result)).not.toThrow();
    });
  });

  describe('resolveStay — cascade tiers', () => {
    it('a fixed-amount cascade plan adds a flat delta on top of baseRate', async () => {
      tx.ratePlan.findMany.mockResolvedValue([plan({ adjustmentType: 'fixed', amount: new Prisma.Decimal('15') })]);
      const result = await service.resolveStay(tx as never, TENANT_ID, BRANCH_ID, ROOM_TYPE as never, new Date('2026-09-01'), new Date('2026-09-02'), {}, { triggeredBy: 'booking_create' });
      expect(result.subtotal.toFixed(2)).toBe('115.00');
      expect(result.ruleApplied.type).toBe('cascade');
    });

    it('a percentage cascade plan multiplies the running total, not the original base', async () => {
      tx.ratePlan.findMany.mockResolvedValue([plan({ adjustmentType: 'percentage', amount: new Prisma.Decimal('10') })]); // +10%
      const result = await service.resolveStay(tx as never, TENANT_ID, BRANCH_ID, ROOM_TYPE as never, new Date('2026-09-01'), new Date('2026-09-02'), {}, { triggeredBy: 'booking_create' });
      expect(result.subtotal.toFixed(2)).toBe('110.00');
    });

    it('multiple tiers apply in cascadeTier order, each on the running total from the last', async () => {
      tx.ratePlan.findMany.mockResolvedValue([
        plan({ id: 'weekend', type: 'weekend', cascadeTier: 3, adjustmentType: 'fixed', amount: new Prisma.Decimal('20') }),
        plan({ id: 'seasonal', type: 'seasonal', cascadeTier: 2, adjustmentType: 'percentage', amount: new Prisma.Decimal('10') }),
      ]);
      // base 100 -> seasonal (tier 2, +10%) -> 110 -> weekend (tier 3, +20 fixed) -> 130
      const result = await service.resolveStay(tx as never, TENANT_ID, BRANCH_ID, ROOM_TYPE as never, new Date('2026-09-01'), new Date('2026-09-02'), {}, { triggeredBy: 'booking_create' });
      expect(result.subtotal.toFixed(2)).toBe('130.00');
    });

    it('a plan outside its validFrom/validTo window for this night does not apply', async () => {
      tx.ratePlan.findMany.mockResolvedValue([plan({ validFrom: new Date('2026-12-01'), validTo: new Date('2026-12-31') })]);
      const result = await service.resolveStay(tx as never, TENANT_ID, BRANCH_ID, ROOM_TYPE as never, new Date('2026-09-01'), new Date('2026-09-02'), {}, { triggeredBy: 'booking_create' });
      expect(result.subtotal.toFixed(2)).toBe('100.00');
    });

    it('two overlapping plans at the SAME tier apply only one, preferring the room-type-specific plan over the branch-wide one', async () => {
      tx.ratePlan.findMany.mockResolvedValue([
        plan({ id: 'branch-wide', roomTypeId: null, amount: new Prisma.Decimal('10'), createdAt: new Date('2026-06-01') }),
        plan({ id: 'type-specific', roomTypeId: TYPE_ID, amount: new Prisma.Decimal('25'), createdAt: new Date('2026-01-01') }),
      ]);
      const result = await service.resolveStay(tx as never, TENANT_ID, BRANCH_ID, ROOM_TYPE as never, new Date('2026-09-01'), new Date('2026-09-02'), {}, { triggeredBy: 'booking_create' });
      expect(result.subtotal.toFixed(2)).toBe('125.00'); // 100 + 25, not +10
    });
  });

  describe('resolveStay — overrides', () => {
    it('a matching promotional plan replaces the rate outright — cascade is skipped entirely', async () => {
      tx.ratePlan.findMany.mockResolvedValue([
        plan({ id: 'seasonal', isOverride: false, adjustmentType: 'fixed', amount: new Prisma.Decimal('999') }), // would win if cascade ran
        plan({ id: 'promo', type: 'promotional', isOverride: true, amount: new Prisma.Decimal('60'), adjustmentType: null, promoCode: 'SAVE40' }),
      ]);
      const result = await service.resolveStay(
        tx as never,
        TENANT_ID,
        BRANCH_ID,
        ROOM_TYPE as never,
        new Date('2026-09-01'),
        new Date('2026-09-02'),
        { promoCode: 'SAVE40' },
        { triggeredBy: 'booking_create' },
      );
      expect(result.subtotal.toFixed(2)).toBe('60.00');
      expect(result.ruleApplied.type).toBe('override');
      expect(result.ratePlanId).toBe('promo');
    });

    it('an unmatched promoCode does not trigger the override — falls through to base/cascade', async () => {
      tx.ratePlan.findMany.mockResolvedValue([plan({ type: 'promotional', isOverride: true, amount: new Prisma.Decimal('60'), adjustmentType: null, promoCode: 'SAVE40' })]);
      const result = await service.resolveStay(
        tx as never,
        TENANT_ID,
        BRANCH_ID,
        ROOM_TYPE as never,
        new Date('2026-09-01'),
        new Date('2026-09-02'),
        { promoCode: 'WRONGCODE' },
        { triggeredBy: 'booking_create' },
      );
      expect(result.subtotal.toFixed(2)).toBe('100.00');
    });

    it('a negotiated plan matched via corporateAccountId beats a promotional plan matched via promoCode', async () => {
      tx.corporateAccount.findFirst.mockResolvedValue({ id: 'corp-1', ratePlanId: 'negotiated-1', isActive: true });
      tx.ratePlan.findMany.mockResolvedValue([
        plan({ id: 'negotiated-1', type: 'negotiated', isOverride: true, amount: new Prisma.Decimal('70'), adjustmentType: null }),
        plan({ id: 'promo-1', type: 'promotional', isOverride: true, amount: new Prisma.Decimal('60'), adjustmentType: null, promoCode: 'SAVE40' }),
      ]);
      const result = await service.resolveStay(
        tx as never,
        TENANT_ID,
        BRANCH_ID,
        ROOM_TYPE as never,
        new Date('2026-09-01'),
        new Date('2026-09-02'),
        { promoCode: 'SAVE40', corporateAccountId: 'corp-1' },
        { triggeredBy: 'booking_create' },
      );
      expect(result.subtotal.toFixed(2)).toBe('70.00');
      expect(result.ratePlanId).toBe('negotiated-1');
    });
  });

  describe('resolveStay — tax integration', () => {
    it('totalWithTax adds the resolved tax on top of the subtotal; confirmedRate-equivalent subtotal stays tax-exclusive', async () => {
      taxesService.computeTaxesForCharge.mockResolvedValue([{ ruleId: 'vat', ruleName: 'VAT', rate: new Prisma.Decimal('0.075'), taxAmount: new Prisma.Decimal('7.50') }]);
      const result = await service.resolveStay(tx as never, TENANT_ID, BRANCH_ID, ROOM_TYPE as never, new Date('2026-09-01'), new Date('2026-09-02'), {}, { triggeredBy: 'booking_create' });
      expect(result.subtotal.toFixed(2)).toBe('100.00');
      expect(result.taxTotal.toFixed(2)).toBe('7.50');
      expect(result.totalWithTax.toFixed(2)).toBe('107.50');
    });
  });

  describe('createRatePlan', () => {
    const base = { name: 'Weekend Uplift', type: 'weekend' as const, amount: 20, adjustmentType: 'fixed' as const };

    it('auto-derives cascadeTier from type — never client-supplied', async () => {
      await service.createRatePlan(TENANT_ID, BRANCH_ID, base);
      expect(tx.ratePlan.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cascadeTier: 3, isOverride: false }) }));
    });

    it('rejects a cascade type (base/seasonal/weekend/corporate) with no adjustmentType', async () => {
      await expect(service.createRatePlan(TENANT_ID, BRANCH_ID, { ...base, adjustmentType: undefined })).rejects.toThrow(BadRequestException);
    });

    it('rejects an override type (negotiated/promotional) that DOES supply an adjustmentType — its amount is absolute, not a delta', async () => {
      await expect(service.createRatePlan(TENANT_ID, BRANCH_ID, { name: 'Corp Deal', type: 'negotiated', amount: 80, adjustmentType: 'fixed' })).rejects.toThrow(BadRequestException);
    });

    it('rejects a promotional plan with no promoCode', async () => {
      await expect(service.createRatePlan(TENANT_ID, BRANCH_ID, { name: 'Flash Sale', type: 'promotional', amount: 60 })).rejects.toThrow(BadRequestException);
    });

    it('a negotiated plan is accepted with no adjustmentType and stores isOverride = true', async () => {
      await service.createRatePlan(TENANT_ID, BRANCH_ID, { name: 'Corp Deal', type: 'negotiated', amount: 80 });
      expect(tx.ratePlan.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isOverride: true, adjustmentType: null, cascadeTier: 0 }) }));
    });

    it('404s when roomTypeId does not belong to this branch', async () => {
      tx.roomType.findFirst.mockResolvedValueOnce(null);
      await expect(service.createRatePlan(TENANT_ID, BRANCH_ID, { ...base, roomTypeId: 'nope' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateRatePlan', () => {
    it('404s on a missing plan', async () => {
      tx.ratePlan.findFirst.mockResolvedValue(null);
      await expect(service.updateRatePlan(TENANT_ID, 'missing', { isActive: false })).rejects.toThrow(NotFoundException);
    });

    it('toggles isActive without deleting', async () => {
      tx.ratePlan.findFirst.mockResolvedValue(plan());
      await service.updateRatePlan(TENANT_ID, 'plan-1', { isActive: false });
      expect(tx.ratePlan.update).toHaveBeenCalledWith({ where: { id: 'plan-1' }, data: { isActive: false } });
    });
  });
});
