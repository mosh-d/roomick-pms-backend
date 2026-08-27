import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { TaxesService } from './taxes.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';

function rule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'rule-vat',
    name: 'VAT',
    rate: new Prisma.Decimal('0.075'),
    appliesToChargeTypes: [] as string[],
    isActive: true,
    ...overrides,
  };
}

function makeTx() {
  return { taxRule: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() } };
}

describe('TaxesService', () => {
  let service: TaxesService;
  let tx: ReturnType<typeof makeTx>;

  beforeEach(async () => {
    tx = makeTx();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TaxesService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: PropertyService, useValue: { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID }) } },
      ],
    }).compile();
    service = moduleRef.get(TaxesService);
  });

  describe('computeTaxesForCharge', () => {
    it('an empty appliesToChargeTypes means the rule taxes EVERY charge type', async () => {
      tx.taxRule.findMany.mockResolvedValue([rule({ appliesToChargeTypes: [] })]);
      const result = await service.computeTaxesForCharge(tx as never, BRANCH_ID, 'fnb', new Prisma.Decimal('20000'));
      expect(result).toHaveLength(1);
      expect(result[0].taxAmount.toFixed(2)).toBe('1500.00');
    });

    it('a scoped rule only applies to its listed charge types', async () => {
      tx.taxRule.findMany.mockResolvedValue([rule({ appliesToChargeTypes: ['room', 'spa'] })]);
      const applies = await service.computeTaxesForCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('100'));
      const doesNot = await service.computeTaxesForCharge(tx as never, BRANCH_ID, 'laundry', new Prisma.Decimal('100'));
      expect(applies).toHaveLength(1);
      expect(doesNot).toHaveLength(0);
    });

    it('rounds to 2dp using Decimal, never floating point', async () => {
      // 8098 * 0.075 = 607.35 exactly; a float would risk 607.3499999...
      tx.taxRule.findMany.mockResolvedValue([rule()]);
      const result = await service.computeTaxesForCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('8098'));
      expect(result[0].taxAmount.toFixed(2)).toBe('607.35');
    });

    it('skips a rule that computes to exactly zero — a 0.00 line item would violate CHECK (amount <> 0)', async () => {
      tx.taxRule.findMany.mockResolvedValue([rule({ id: 'zero-rate', rate: new Prisma.Decimal('0') })]);
      const result = await service.computeTaxesForCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('20000'));
      expect(result).toHaveLength(0);
    });

    it('skips a rule whose tax rounds down to zero on a tiny charge', async () => {
      // 0.05 * 0.075 = 0.00375 -> rounds to 0.00
      tx.taxRule.findMany.mockResolvedValue([rule()]);
      const result = await service.computeTaxesForCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('0.05'));
      expect(result).toHaveLength(0);
    });

    it('returns one entry per matching rule so each becomes its own tax line item', async () => {
      tx.taxRule.findMany.mockResolvedValue([
        rule({ id: 'vat', name: 'VAT', rate: new Prisma.Decimal('0.075') }),
        rule({ id: 'svc', name: 'Service Charge', rate: new Prisma.Decimal('0.10') }),
      ]);
      const result = await service.computeTaxesForCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('10000'));
      expect(result.map((r) => [r.ruleName, r.taxAmount.toFixed(2)])).toEqual([
        ['VAT', '750.00'],
        ['Service Charge', '1000.00'],
      ]);
    });

    it('only considers active rules', async () => {
      await service.computeTaxesForCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('100'));
      expect(tx.taxRule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { branchId: BRANCH_ID, isActive: true } }),
      );
    });
  });

  describe('updateTaxRule', () => {
    it('retires by flipping isActive, never deleting (historical taxRuleIds must keep resolving)', async () => {
      tx.taxRule.findFirst.mockResolvedValue(rule());
      tx.taxRule.update.mockResolvedValue(rule({ isActive: false }));
      await service.updateTaxRule(TENANT_ID, 'rule-vat', { isActive: false });
      expect(tx.taxRule.update).toHaveBeenCalledWith({ where: { id: 'rule-vat' }, data: { isActive: false } });
    });
  });
});
