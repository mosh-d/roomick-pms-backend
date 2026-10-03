import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { JwtPayload } from '../../common/types/request-context';
import { TaxesService, describeRule } from './taxes.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';

function rule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'rule-vat',
    name: 'VAT',
    rate: new Prisma.Decimal('0.075'),
    type: 'percentage',
    fixedAmount: null as Prisma.Decimal | null,
    inclusive: false,
    appliesToChargeTypes: [] as string[],
    isActive: true,
    ...overrides,
  };
}

function makeTx() {
  return {
    taxRule: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'rule-new', isActive: true, ...data })),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(rule({ branchId: BRANCH_ID, ...data }))),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
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

  describe('priceCharge', () => {
    it('an empty appliesToChargeTypes means the rule taxes EVERY charge type', async () => {
      tx.taxRule.findMany.mockResolvedValue([rule({ appliesToChargeTypes: [] })]);
      const result = await service.priceCharge(tx as never, BRANCH_ID, 'fnb', new Prisma.Decimal('20000'));
      expect(result.taxes).toHaveLength(1);
      expect(result.taxes[0].taxAmount.toFixed(2)).toBe('1500.00');
      // added on top: the charge posts whole and the guest pays it plus the tax
      expect(result.net.toFixed(2)).toBe('20000.00');
      expect(result.total.toFixed(2)).toBe('21500.00');
    });

    it('a scoped rule only applies to its listed charge types', async () => {
      tx.taxRule.findMany.mockResolvedValue([rule({ appliesToChargeTypes: ['room', 'spa'] })]);
      const applies = await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('100'));
      const doesNot = await service.priceCharge(tx as never, BRANCH_ID, 'laundry', new Prisma.Decimal('100'));
      expect(applies.taxes).toHaveLength(1);
      expect(doesNot.taxes).toHaveLength(0);
      expect(doesNot.total.toFixed(2)).toBe('100.00');
    });

    it('rounds to 2dp using Decimal, never floating point', async () => {
      // 8098 * 0.075 = 607.35 exactly; a float would risk 607.3499999...
      tx.taxRule.findMany.mockResolvedValue([rule()]);
      const result = await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('8098'));
      expect(result.taxes[0].taxAmount.toFixed(2)).toBe('607.35');
    });

    it('skips a rule that computes to exactly zero — a 0.00 line item would violate CHECK (amount <> 0)', async () => {
      tx.taxRule.findMany.mockResolvedValue([rule({ id: 'zero-rate', rate: new Prisma.Decimal('0') })]);
      const result = await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('20000'));
      expect(result.taxes).toHaveLength(0);
    });

    it('skips a rule whose tax rounds down to zero on a tiny charge', async () => {
      // 0.05 * 0.075 = 0.00375 -> rounds to 0.00
      tx.taxRule.findMany.mockResolvedValue([rule()]);
      const result = await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('0.05'));
      expect(result.taxes).toHaveLength(0);
    });

    it('returns one entry per matching rule so each becomes its own tax line item', async () => {
      tx.taxRule.findMany.mockResolvedValue([
        rule({ id: 'vat', name: 'VAT', rate: new Prisma.Decimal('0.075') }),
        rule({ id: 'svc', name: 'Service Charge', rate: new Prisma.Decimal('0.10') }),
      ]);
      const result = await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('10000'));
      expect(result.taxes.map((r) => [r.ruleName, r.taxAmount.toFixed(2)])).toEqual([
        ['VAT', '750.00'],
        ['Service Charge', '1000.00'],
      ]);
    });

    it('only considers active rules', async () => {
      await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('100'));
      expect(tx.taxRule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { branchId: BRANCH_ID, isActive: true } }),
      );
    });

    it('never taxes a tax line or a correction, even under an "all charges" rule', async () => {
      tx.taxRule.findMany.mockResolvedValue([rule()]);
      expect((await service.priceCharge(tx as never, BRANCH_ID, 'correction', new Prisma.Decimal('100'))).taxes).toHaveLength(0);
      expect((await service.priceCharge(tx as never, BRANCH_ID, 'tax', new Prisma.Decimal('100'))).taxes).toHaveLength(0);
      expect(tx.taxRule.findMany).not.toHaveBeenCalled();
    });

    it('taxes nothing at a price of zero — a complimentary night owes no fixed tax', async () => {
      tx.taxRule.findMany.mockResolvedValue([rule({ type: 'fixed', rate: new Prisma.Decimal(0), fixedAmount: new Prisma.Decimal('500') })]);
      const result = await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('0'));
      expect(result.taxes).toHaveLength(0);
      expect(result.total.toFixed(2)).toBe('0.00');
    });
  });

  describe('taxes included in the price', () => {
    const includedVat = () => rule({ inclusive: true });

    it('takes an included percentage out of the price instead of adding it', async () => {
      tx.taxRule.findMany.mockResolvedValue([includedVat()]);
      const result = await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('100000'));
      // 100,000 / 1.075 = 93,023.2558… → VAT 6,976.74, and the two make the price exactly
      expect(result.taxes[0].taxAmount.toFixed(2)).toBe('6976.74');
      expect(result.taxes[0].inclusive).toBe(true);
      expect(result.net.toFixed(2)).toBe('93023.26');
      expect(result.includedTax.toFixed(2)).toBe('6976.74');
      expect(result.addedTax.toFixed(2)).toBe('0.00');
      expect(result.total.toFixed(2)).toBe('100000.00');
    });

    it('splits a price holding two included rates between them, to the cent', async () => {
      tx.taxRule.findMany.mockResolvedValue([includedVat(), rule({ id: 'svc', name: 'Service Charge', rate: new Prisma.Decimal('0.10'), inclusive: true })]);
      const result = await service.priceCharge(tx as never, BRANCH_ID, 'fnb', new Prisma.Decimal('10000'));
      // base = 10,000 / 1.175 = 8,510.6383…
      expect(result.taxes.map((t) => t.taxAmount.toFixed(2))).toEqual(['638.30', '851.06']);
      expect(result.net.toFixed(2)).toBe('8510.64');
      expect(result.net.plus(result.includedTax).toFixed(2)).toBe('10000.00');
      expect(result.total.toFixed(2)).toBe('10000.00');
    });

    it('takes an added tax of the same pre-tax amount the included one used', async () => {
      tx.taxRule.findMany.mockResolvedValue([includedVat(), rule({ id: 'levy', name: 'Levy', rate: new Prisma.Decimal('0.05') })]);
      const result = await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('107500'));
      expect(result.taxes.find((t) => t.ruleId === 'rule-vat')!.taxAmount.toFixed(2)).toBe('7500.00');
      expect(result.taxes.find((t) => t.ruleId === 'levy')!.taxAmount.toFixed(2)).toBe('5000.00');
      expect(result.net.toFixed(2)).toBe('100000.00');
      expect(result.total.toFixed(2)).toBe('112500.00');
    });

    it('takes an included fixed amount out once per night', async () => {
      tx.taxRule.findMany.mockResolvedValue([rule({ id: 'city', name: 'City Tax', type: 'fixed', rate: new Prisma.Decimal(0), fixedAmount: new Prisma.Decimal('500'), inclusive: true })]);
      const result = await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('90000'), 3);
      expect(result.includedTax.toFixed(2)).toBe('1500.00');
      expect(result.net.toFixed(2)).toBe('88500.00');
      expect(result.total.toFixed(2)).toBe('90000.00');
    });

    it('refuses a charge smaller than the fixed tax it is meant to include', async () => {
      tx.taxRule.findMany.mockResolvedValue([rule({ id: 'city', name: 'City Tax', type: 'fixed', rate: new Prisma.Decimal(0), fixedAmount: new Prisma.Decimal('500'), inclusive: true })]);
      await expect(service.priceCharge(tx as never, BRANCH_ID, 'fnb', new Prisma.Decimal('300'))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('says so on the bill', () => {
      expect(describeRule(includedVat() as never)).toBe('VAT (7.5%, included)');
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

  describe('fixed-amount rules', () => {
    const cityTax = () => rule({ id: 'rule-city', name: 'City Tax', type: 'fixed', rate: new Prisma.Decimal(0), fixedAmount: new Prisma.Decimal('500'), appliesToChargeTypes: ['room'] });

    it('adds the amount once per charge, whatever the charge is', async () => {
      tx.taxRule.findMany.mockResolvedValue([cityTax()]);
      const small = await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('10000'));
      const large = await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('90000'));
      expect(small.taxes[0].taxAmount.toFixed(2)).toBe('500.00');
      expect(large.taxes[0].taxAmount.toFixed(2)).toBe('500.00');
    });

    it('counts once per night when a quote stands for several nights — percentages don’t change', async () => {
      tx.taxRule.findMany.mockResolvedValue([cityTax(), rule()]);
      const quote = await service.priceCharge(tx as never, BRANCH_ID, 'room', new Prisma.Decimal('90000'), 3);
      expect(quote.taxes.find((t) => t.ruleId === 'rule-city')!.taxAmount.toFixed(2)).toBe('1500.00');
      expect(quote.taxes.find((t) => t.ruleId === 'rule-vat')!.taxAmount.toFixed(2)).toBe('6750.00');
    });

    it('reads on a bill as a fixed amount, a percentage as a percentage', () => {
      expect(describeRule(cityTax() as never)).toBe('City Tax (fixed 500.00)');
      expect(describeRule(rule() as never)).toBe('VAT (7.5%)');
    });
  });

  describe('creating and changing rules', () => {
    const owner: JwtPayload = { sub: 'user-1', tenantId: TENANT_ID, email: 'o@x.com', roles: [{ branchId: null, role: 'owner' }], tokenType: 'access' };
    const otherBranchManager: JwtPayload = { ...owner, roles: [{ branchId: 'another-branch', role: 'manager' }] };

    it('stores a fixed rule with no percentage, and a percentage rule with no amount', async () => {
      tx.taxRule.findFirst.mockResolvedValue(null);
      await service.createTaxRule(TENANT_ID, BRANCH_ID, { name: 'City Tax', type: 'fixed', fixedAmount: 500, appliesToChargeTypes: ['room'] }, 'user-1');
      expect((tx.taxRule.create.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({ type: 'fixed', rate: new Prisma.Decimal(0), fixedAmount: new Prisma.Decimal(500) });
      await service.createTaxRule(TENANT_ID, BRANCH_ID, { name: 'VAT', rate: 0.075 }, 'user-1');
      expect((tx.taxRule.create.mock.calls[1][0] as { data: Record<string, unknown> }).data).toMatchObject({ type: 'percentage', fixedAmount: null, inclusive: false });
      await service.createTaxRule(TENANT_ID, BRANCH_ID, { name: 'Consumption Tax', rate: 0.05, inclusive: true }, 'user-1');
      expect((tx.taxRule.create.mock.calls[2][0] as { data: Record<string, unknown> }).data).toMatchObject({ inclusive: true });
      expect(tx.auditLog.create).toHaveBeenCalledTimes(3);
    });

    it('refuses a rule missing the field its kind needs, or carrying the other kind’s', async () => {
      await expect(service.createTaxRule(TENANT_ID, BRANCH_ID, { name: 'City Tax', type: 'fixed' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.createTaxRule(TENANT_ID, BRANCH_ID, { name: 'VAT' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.createTaxRule(TENANT_ID, BRANCH_ID, { name: 'VAT', rate: 0.075, fixedAmount: 5 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('won’t allow two active rules with the same name at a branch', async () => {
      tx.taxRule.findFirst.mockResolvedValue(rule());
      await expect(service.createTaxRule(TENANT_ID, BRANCH_ID, { name: 'vat', rate: 0.1 })).rejects.toBeInstanceOf(ConflictException);
    });

    it('replacing retires the old rule and creates the new one together', async () => {
      tx.taxRule.findFirst.mockResolvedValueOnce(rule({ branchId: BRANCH_ID })).mockResolvedValueOnce(null);
      const replacement = await service.replaceTaxRule(TENANT_ID, 'rule-vat', { name: 'VAT', rate: 0.1 }, owner);
      expect(tx.taxRule.update).toHaveBeenCalledWith({ where: { id: 'rule-vat' }, data: { isActive: false } });
      expect(replacement).toMatchObject({ name: 'VAT', rate: new Prisma.Decimal(0.1) });
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'tax_rule.replaced' }) }));
    });

    it('checks the role at the rule’s own branch — the route names no branch', async () => {
      tx.taxRule.findFirst.mockResolvedValue(rule({ branchId: BRANCH_ID }));
      await expect(service.replaceTaxRule(TENANT_ID, 'rule-vat', { name: 'VAT', rate: 0.1 }, otherBranchManager)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.updateTaxRule(TENANT_ID, 'rule-vat', { isActive: false }, otherBranchManager)).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.taxRule.update).not.toHaveBeenCalled();
    });
  });
});
