import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { ShiftsService } from './shifts.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '44444444-4444-4444-8444-444444444444';
const SHIFT_ID = '55555555-5555-4555-8555-555555555555';

function branch(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: BRANCH_ID, timezone: 'Africa/Lagos', currency: 'NGN', policies: null, ...overrides };
}

function shift(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SHIFT_ID,
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    agentId: AGENT_ID,
    shiftType: 'morning',
    openingFloat: new Prisma.Decimal('50000'),
    closedAt: null,
    ...overrides,
  };
}

function makeTx() {
  return {
    shift: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: SHIFT_ID, closedAt: null, ...data })),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...shift(), ...data })),
      findMany: jest.fn().mockResolvedValue([]),
    },
    shiftIssue: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'issue-1', status: 'open', ...data })),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'issue-1', ...data })),
    },
    payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }) },
    posOrder: { aggregate: jest.fn().mockResolvedValue({ _sum: { total: null } }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('ShiftsService', () => {
  let service: ShiftsService;
  let tx: ReturnType<typeof makeTx>;
  let propertyService: { assertBranch: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    propertyService = { assertBranch: jest.fn().mockResolvedValue(branch()) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ShiftsService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: PropertyService, useValue: propertyService },
      ],
    }).compile();
    service = moduleRef.get(ShiftsService);
  });

  describe('openShift', () => {
    it('creates a shift with the opening float and breakdown', async () => {
      await service.openShift(TENANT_ID, BRANCH_ID, { shiftType: 'morning', openingFloat: 50000, openingBreakdown: [{ denomination: 1000, count: 50 }] }, AGENT_ID);
      expect(tx.shift.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tenantId: TENANT_ID, branchId: BRANCH_ID, agentId: AGENT_ID, shiftType: 'morning' }),
        }),
      );
      expect(tx.auditLog.create).toHaveBeenCalled();
    });

    it('rejects opening a second shift while one is already open for this agent+branch', async () => {
      tx.shift.findFirst.mockResolvedValue(shift());
      await expect(service.openShift(TENANT_ID, BRANCH_ID, { shiftType: 'morning', openingFloat: 50000 }, AGENT_ID)).rejects.toThrow(ConflictException);
      expect(tx.shift.create).not.toHaveBeenCalled();
    });
  });

  describe('closeShift', () => {
    it('computes systemCashTotal as openingFloat + summed cash payments, and a zero variance closes cleanly', async () => {
      tx.shift.findFirst.mockResolvedValue(shift({ openingFloat: new Prisma.Decimal('50000') }));
      tx.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('20000') } });

      await service.closeShift(TENANT_ID, SHIFT_ID, { closingCashCounted: 70000 }, AGENT_ID);

      expect(tx.shift.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SHIFT_ID },
          data: expect.objectContaining({
            closedAt: expect.any(Date),
          }),
        }),
      );
      const data = tx.shift.update.mock.calls[0][0].data;
      expect(data.systemCashTotal.toFixed(2)).toBe('70000.00');
      expect(data.variance.toFixed(2)).toBe('0.00');
    });

    it('nets refunds (negative cash payments) into the same total', async () => {
      tx.shift.findFirst.mockResolvedValue(shift({ openingFloat: new Prisma.Decimal('50000') }));
      tx.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('15000') } }); // 20000 taken, 5000 refunded, already netted by the DB sum

      await service.closeShift(TENANT_ID, SHIFT_ID, { closingCashCounted: 65000 }, AGENT_ID);

      const data = tx.shift.update.mock.calls[0][0].data;
      expect(data.systemCashTotal.toFixed(2)).toBe('65000.00');
      expect(data.variance.toFixed(2)).toBe('0.00');
    });

    it('expects the Point of Sale cash rung up this shift in the drawer too, voided sales excluded', async () => {
      tx.shift.findFirst.mockResolvedValue(shift({ openingFloat: new Prisma.Decimal('50000') }));
      tx.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('20000') } });
      tx.posOrder.aggregate.mockResolvedValue({ _sum: { total: new Prisma.Decimal('5375') } });

      await service.closeShift(TENANT_ID, SHIFT_ID, { closingCashCounted: 75375 }, AGENT_ID);

      expect(tx.posOrder.aggregate).toHaveBeenCalledWith({ _sum: { total: true }, where: { shiftId: SHIFT_ID, settlement: 'cash', voidedAt: null } });
      const data = tx.shift.update.mock.calls[0][0].data;
      expect(data.systemCashTotal.toFixed(2)).toBe('75375.00');
      expect(data.variance.toFixed(2)).toBe('0.00');
    });

    it('rejects closing with a variance past the default threshold and no explanation', async () => {
      tx.shift.findFirst.mockResolvedValue(shift({ openingFloat: new Prisma.Decimal('50000') }));
      tx.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('0') } });

      await expect(service.closeShift(TENANT_ID, SHIFT_ID, { closingCashCounted: 50100 }, AGENT_ID)).rejects.toThrow(BadRequestException);
      expect(tx.shift.update).not.toHaveBeenCalled();
    });

    it('accepts the same variance once an explanation is given', async () => {
      tx.shift.findFirst.mockResolvedValue(shift({ openingFloat: new Prisma.Decimal('50000') }));
      tx.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('0') } });

      await service.closeShift(TENANT_ID, SHIFT_ID, { closingCashCounted: 50100, varianceExplanation: 'Till float miscounted at open.' }, AGENT_ID);
      expect(tx.shift.update).toHaveBeenCalled();
    });

    it('honours a branch-configured threshold over the default', async () => {
      propertyService.assertBranch.mockResolvedValue(branch({ policies: { cashVarianceThreshold: 200 } }));
      tx.shift.findFirst.mockResolvedValue(shift({ openingFloat: new Prisma.Decimal('50000') }));
      tx.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('0') } });

      // 100 variance would fail the 5.00 default but passes a 200 branch threshold with no explanation needed.
      await service.closeShift(TENANT_ID, SHIFT_ID, { closingCashCounted: 50100 }, AGENT_ID);
      expect(tx.shift.update).toHaveBeenCalled();
    });

    it('rejects closing an already-closed shift', async () => {
      tx.shift.findFirst.mockResolvedValue(shift({ closedAt: new Date() }));
      await expect(service.closeShift(TENANT_ID, SHIFT_ID, { closingCashCounted: 50000 }, AGENT_ID)).rejects.toThrow(ConflictException);
    });

    it('404s on a shift that does not exist', async () => {
      tx.shift.findFirst.mockResolvedValue(null);
      await expect(service.closeShift(TENANT_ID, SHIFT_ID, { closingCashCounted: 50000 }, AGENT_ID)).rejects.toThrow(NotFoundException);
    });

    it('logs bundled unresolvedIssues against the closing shift, in the same call', async () => {
      tx.shift.findFirst.mockResolvedValue(shift({ openingFloat: new Prisma.Decimal('50000') }));
      tx.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('0') } });

      await service.closeShift(
        TENANT_ID,
        SHIFT_ID,
        { closingCashCounted: 50000, unresolvedIssues: [{ description: 'Room 214 minibar restock pending' }, { description: 'Guest disputing a charge', priority: 'high' }] },
        AGENT_ID,
      );

      expect(tx.shiftIssue.create).toHaveBeenCalledTimes(2);
      expect(tx.shiftIssue.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ shiftId: SHIFT_ID, priority: 'medium' }) }));
      expect(tx.shiftIssue.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ priority: 'high' }) }));
    });
  });

  describe('addShiftIssue / updateShiftIssue', () => {
    it('creates an issue defaulting priority to medium', async () => {
      tx.shift.findFirst.mockResolvedValue(shift());
      await service.addShiftIssue(TENANT_ID, SHIFT_ID, { description: 'POS terminal offline' }, AGENT_ID);
      expect(tx.shiftIssue.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ priority: 'medium' }) }));
    });

    it('rejects updating an already-resolved issue', async () => {
      tx.shiftIssue.findFirst.mockResolvedValue({ id: 'issue-1', status: 'resolved', shift: shift() });
      await expect(service.updateShiftIssue(TENANT_ID, 'issue-1', { status: 'resolved', resolution: 'done' }, AGENT_ID)).rejects.toThrow(ConflictException);
    });

    it('resolves an open issue, stamping who and when', async () => {
      tx.shiftIssue.findFirst.mockResolvedValue({ id: 'issue-1', status: 'open', shift: shift() });
      await service.updateShiftIssue(TENANT_ID, 'issue-1', { status: 'resolved', resolution: 'IT swapped the terminal' }, AGENT_ID);
      expect(tx.shiftIssue.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'resolved', resolvedBy: AGENT_ID, resolvedAt: expect.any(Date) }) }),
      );
    });

    it('carries an issue over without stamping resolvedBy/resolvedAt', async () => {
      tx.shiftIssue.findFirst.mockResolvedValue({ id: 'issue-1', status: 'open', shift: shift() });
      await service.updateShiftIssue(TENANT_ID, 'issue-1', { status: 'carried_over' }, AGENT_ID);
      const data = tx.shiftIssue.update.mock.calls[0][0].data;
      expect(data.status).toBe('carried_over');
      expect(data.resolvedBy).toBeUndefined();
      expect(data.resolvedAt).toBeUndefined();
    });

    it('allows carrying over an issue that was already carried over once', async () => {
      tx.shiftIssue.findFirst.mockResolvedValue({ id: 'issue-1', status: 'carried_over', shift: shift() });
      await service.updateShiftIssue(TENANT_ID, 'issue-1', { status: 'carried_over' }, AGENT_ID);
      expect(tx.shiftIssue.update).toHaveBeenCalled();
    });
  });

  describe('getHandoverContext', () => {
    it('returns the last closed shift plus every unresolved issue branch-wide', async () => {
      tx.shift.findFirst.mockResolvedValue(shift({ closedAt: new Date() }));
      tx.shiftIssue.findMany.mockResolvedValue([{ id: 'issue-1', status: 'open' }]);

      const result = await service.getHandoverContext(TENANT_ID, BRANCH_ID);
      expect(result.lastClosedShift).toBeTruthy();
      expect(result.unresolvedIssues).toHaveLength(1);
      expect(tx.shiftIssue.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { shift: { branchId: BRANCH_ID }, status: { not: 'resolved' } } }),
      );
    });
  });
});
