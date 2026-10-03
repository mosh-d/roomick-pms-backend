import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AdjustmentType, ChargeType, Prisma, TaxRule } from '@prisma/client';
import { SystemRole } from '../../common/decorators/roles.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { assertRoleAtBranch } from '../../common/utils/branch-roles';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { CreateTaxRuleDto, ReplaceTaxRuleDto, UpdateTaxRuleDto } from './dto/tax-rule.dto';

/** One rule's computed contribution to a charge — what `FoliosService` turns into a `chargeType: 'tax'` line item. */
export interface ComputedTax {
  ruleId: string;
  ruleName: string;
  type: AdjustmentType;
  /** Percentage rules: 0.075 = 7.5%. Zero for a fixed rule. */
  rate: Prisma.Decimal;
  /** Fixed rules: the amount per charge. Null for a percentage rule. */
  fixedAmount: Prisma.Decimal | null;
  /** True when this tax was already inside the price rather than added on top of it. */
  inclusive: boolean;
  taxAmount: Prisma.Decimal;
}

/**
 * A price run through the branch's tax rules. Two kinds of tax meet here:
 * one **added on top** of the price (the default), and one **included** in it
 * — a property that quotes VAT-inclusive rates. Either way the ledger is the
 * same shape: the charge line carries `net`, each tax its own line, and they
 * add up to `total`.
 *
 * - `price`: as entered — a room rate, a menu price.
 * - `net`: the price with included tax taken out. What a charge line posts,
 *   and what revenue reports count.
 * - `includedTax` + `addedTax` = `taxTotal`, the tax lines between them.
 * - `total` = `price` + `addedTax` = `net` + `taxTotal`: what the guest pays.
 */
export interface PricedCharge {
  price: Prisma.Decimal;
  net: Prisma.Decimal;
  taxes: ComputedTax[];
  taxTotal: Prisma.Decimal;
  includedTax: Prisma.Decimal;
  addedTax: Prisma.Decimal;
  total: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);
const ONE = new Prisma.Decimal(1);

/** A rule left on "all charges" taxes every real sale — never another tax line, or a correction reversing one. */
const NEVER_TAXED: ReadonlySet<ChargeType> = new Set<ChargeType>(['tax', 'correction']);

/** Who may set a branch's taxes: the people who answer for its books. */
const TAX_ADMIN_ROLES = [SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant];

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

/** How a rule reads on a bill: "VAT (7.5%)", "City Tax (fixed 500.00)", "VAT (7.5%, included)". */
export function describeRule(rule: { name: string; type: AdjustmentType; rate: Prisma.Decimal; fixedAmount: Prisma.Decimal | null; inclusive?: boolean }): string {
  const amount = rule.type === 'fixed' && rule.fixedAmount ? `fixed ${rule.fixedAmount.toFixed(2)}` : `${rule.rate.mul(100).toDecimalPlaces(2).toString()}%`;
  return `${rule.name} (${amount}${rule.inclusive ? ', included' : ''})`;
}

@Injectable()
export class TaxesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
  ) {}

  async createTaxRule(tenantId: string, branchId: string, dto: CreateTaxRuleDto, actorId?: string): Promise<TaxRule> {
    const shape = this.assertShape(dto);
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      await this.assertNameFree(tx, branchId, dto.name);
      const rule = await tx.taxRule.create({ data: { tenantId, branchId, ...shape } });
      await this.audit(tx, tenantId, branchId, actorId ?? null, 'tax_rule.created', rule.id, this.snapshot(rule));
      return rule;
    });
  }

  async listTaxRules(tenantId: string, branchId: string): Promise<TaxRule[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      return tx.taxRule.findMany({ where: { branchId }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
    });
  }

  /**
   * Retires/reinstates a rule. Never deletes — a deleted rule would orphan the
   * `taxRuleIds` on every historical tax line item that references it.
   * `actor` is checked at the rule's own branch: the route names no branch,
   * so `RolesGuard` alone would accept a role held at any of the tenant's.
   */
  async updateTaxRule(tenantId: string, taxRuleId: string, dto: UpdateTaxRuleDto, actor?: JwtPayload): Promise<TaxRule> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rule = await this.findRule(tx, taxRuleId);
      if (actor) assertRoleAtBranch(actor, rule.branchId, TAX_ADMIN_ROLES);
      if (dto.isActive === true && !rule.isActive) await this.assertNameFree(tx, rule.branchId, rule.name, rule.id);
      const updated = await tx.taxRule.update({
        where: { id: taxRuleId },
        data: { ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}) },
      });
      if (dto.isActive !== undefined && dto.isActive !== rule.isActive) {
        await this.audit(tx, tenantId, rule.branchId, actor?.sub ?? null, dto.isActive ? 'tax_rule.reinstated' : 'tax_rule.retired', rule.id, this.snapshot(updated));
      }
      return updated;
    });
  }

  /**
   * A new rate, amount or scope for an active rule: the old rule is retired and
   * its replacement created in one transaction, so there's never a moment with
   * no rule, and bills already posted keep pointing at the rule they were
   * actually charged under.
   */
  async replaceTaxRule(tenantId: string, taxRuleId: string, dto: ReplaceTaxRuleDto, actor: JwtPayload): Promise<TaxRule> {
    const shape = this.assertShape(dto);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const old = await this.findRule(tx, taxRuleId);
      assertRoleAtBranch(actor, old.branchId, TAX_ADMIN_ROLES);
      if (!old.isActive) throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'That rule is already retired — reinstate it, or add a new one' });
      await this.assertNameFree(tx, old.branchId, dto.name, old.id);
      await tx.taxRule.update({ where: { id: old.id }, data: { isActive: false } });
      const replacement = await tx.taxRule.create({ data: { tenantId, branchId: old.branchId, ...shape } });
      await this.audit(tx, tenantId, old.branchId, actor.sub, 'tax_rule.replaced', replacement.id, {
        replaces: old.id,
        before: this.snapshot(old),
        after: this.snapshot(replacement),
      });
      return replacement;
    });
  }

  /**
   * The tax engine (spec §4.5): prices a charge under the branch's active
   * rules that cover its type — `appliesToChargeTypes: []` means every real
   * charge type, matching the schema's own comment.
   *
   * Takes an already-open transaction so it runs inside the same atomic
   * unit as the charge it's taxing: a charge and its taxes must be written
   * together or not at all.
   *
   * **Included taxes** come out of the price first. With included rates R
   * and included fixed amounts F, the pre-tax amount is (price − F) / (1 + R);
   * every percentage, included or added, is taken of that same amount, so a
   * rule taxes the same base whichever way the property quotes. `net` is the
   * price less the rounded included taxes, so `net` + included tax is the
   * price to the cent.
   *
   * `units` is how many separate charges `price` stands for. It only matters
   * to a fixed rule, which is charged once per charge: a quote for a
   * three-night stay is one amount but three room-night postings, so the
   * Rate Resolver passes 3 and the quote carries the fixed tax three times —
   * exactly what the nights will post. A percentage is the same either way.
   *
   * Nothing is taxed at a price of zero or less — a complimentary night
   * posts nothing, so it owes no fixed tax either.
   *
   * **Taxes computing to exactly 0 are dropped**, not returned as zero rows:
   * `line_items` carries a DB-level `CHECK (amount <> 0)` (see
   * `20260712000001_rls_and_constraints`), so a 0.00 tax line would abort
   * the whole transaction. Reachable via a 0% rule or a charge small enough
   * to round to zero.
   */
  async priceCharge(tx: TenantTx, branchId: string, chargeType: ChargeType, price: Prisma.Decimal, units = 1): Promise<PricedCharge> {
    const untaxed: PricedCharge = { price, net: price, taxes: [], taxTotal: ZERO, includedTax: ZERO, addedTax: ZERO, total: price };
    if (NEVER_TAXED.has(chargeType) || !price.greaterThan(0)) return untaxed;

    const rules = (await tx.taxRule.findMany({ where: { branchId, isActive: true }, orderBy: { name: 'asc' } })).filter(
      (rule) => rule.appliesToChargeTypes.length === 0 || rule.appliesToChargeTypes.includes(chargeType),
    );
    if (rules.length === 0) return untaxed;

    const isFixed = (rule: TaxRule) => rule.type === 'fixed' && rule.fixedAmount !== null;
    const fixedFor = (rule: TaxRule) => (rule.fixedAmount ?? ZERO).mul(units);
    const included = rules.filter((rule) => rule.inclusive);
    const includedFixed = included.filter(isFixed).reduce((sum, rule) => sum.plus(fixedFor(rule)), ZERO);
    const includedRate = included.filter((rule) => !isFixed(rule)).reduce((sum, rule) => sum.plus(rule.rate), ZERO);
    // Decimal arithmetic end to end — never floats (spec §6).
    const base = price.minus(includedFixed).div(ONE.plus(includedRate));
    if (!base.greaterThan(0)) {
      throw invalid(`The taxes included in a charge of ${price.toFixed(2)} come to more than the charge itself — check this branch's fixed taxes`);
    }

    const taxes: ComputedTax[] = rules
      .map((rule) => ({
        ruleId: rule.id,
        ruleName: rule.name,
        type: rule.type,
        rate: rule.rate,
        fixedAmount: rule.fixedAmount,
        inclusive: rule.inclusive,
        // Money is NUMERIC(12,2): round at the point of computation rather
        // than letting Postgres truncate on insert.
        taxAmount: (isFixed(rule) ? fixedFor(rule) : base.mul(rule.rate)).toDecimalPlaces(2),
      }))
      .filter((computed) => !computed.taxAmount.isZero());

    const includedTax = taxes.filter((t) => t.inclusive).reduce((sum, t) => sum.plus(t.taxAmount), ZERO);
    const addedTax = taxes.filter((t) => !t.inclusive).reduce((sum, t) => sum.plus(t.taxAmount), ZERO);
    return {
      price,
      net: price.minus(includedTax),
      taxes,
      taxTotal: includedTax.plus(addedTax),
      includedTax,
      addedTax,
      total: price.plus(addedTax),
    };
  }

  /** The two kinds of rule carry different fields; this is the one place that decides which. */
  private assertShape(dto: CreateTaxRuleDto): {
    name: string;
    type: AdjustmentType;
    rate: Prisma.Decimal;
    fixedAmount: Prisma.Decimal | null;
    inclusive: boolean;
    appliesToChargeTypes: ChargeType[];
    jurisdiction: string | null;
  } {
    const name = dto.name.trim();
    if (!name) throw invalid('Give the tax a name, such as VAT');
    const type = dto.type ?? 'percentage';
    if (type === 'fixed') {
      if (dto.fixedAmount === undefined || dto.fixedAmount <= 0) throw invalid('A fixed tax needs an amount above zero');
      if (dto.rate !== undefined && dto.rate !== 0) throw invalid('A fixed tax is an amount, not a percentage — leave the rate out');
      return {
        name,
        type,
        rate: new Prisma.Decimal(0),
        fixedAmount: new Prisma.Decimal(dto.fixedAmount),
        inclusive: dto.inclusive ?? false,
        appliesToChargeTypes: dto.appliesToChargeTypes ?? [],
        jurisdiction: dto.jurisdiction?.trim() || null,
      };
    }
    if (dto.rate === undefined) throw invalid('A percentage tax needs a rate, such as 0.075 for 7.5%');
    if (dto.fixedAmount !== undefined) throw invalid('A percentage tax has no fixed amount — leave it out');
    return {
      name,
      type: 'percentage',
      rate: new Prisma.Decimal(dto.rate),
      fixedAmount: null,
      inclusive: dto.inclusive ?? false,
      appliesToChargeTypes: dto.appliesToChargeTypes ?? [],
      jurisdiction: dto.jurisdiction?.trim() || null,
    };
  }

  /** Two active rules with one name would print two indistinguishable lines on every bill. */
  private async assertNameFree(tx: TenantTx, branchId: string, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.taxRule.findFirst({
      where: { branchId, isActive: true, name: { equals: name.trim(), mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (clash) throw new ConflictException({ code: ErrorCode.CONFLICT, message: `An active tax called “${clash.name}” already exists here — change that one instead` });
  }

  private async findRule(tx: TenantTx, taxRuleId: string): Promise<TaxRule> {
    const rule = await tx.taxRule.findFirst({ where: { id: taxRuleId } });
    if (!rule) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Tax rule not found' });
    return rule;
  }

  private snapshot(rule: TaxRule): Prisma.InputJsonValue {
    return {
      name: rule.name,
      type: rule.type,
      rate: rule.rate.toString(),
      fixedAmount: rule.fixedAmount?.toFixed(2) ?? null,
      inclusive: rule.inclusive,
      appliesToChargeTypes: rule.appliesToChargeTypes,
      isActive: rule.isActive,
    };
  }

  private async audit(tx: TenantTx, tenantId: string, branchId: string, userId: string | null, action: string, entityId: string, after: Prisma.InputJsonValue): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, branchId, userId, action, entityType: 'tax_rule', entityId, after } });
  }
}
