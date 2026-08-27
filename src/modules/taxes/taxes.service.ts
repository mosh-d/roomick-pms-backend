import { Injectable, NotFoundException } from '@nestjs/common';
import { ChargeType, Prisma, TaxRule } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { CreateTaxRuleDto, DEFAULT_TAX_RULE_TYPE, UpdateTaxRuleDto } from './dto/tax-rule.dto';

/** One rule's computed contribution to a charge — what `FoliosService` turns into a `chargeType: 'tax'` line item. */
export interface ComputedTax {
  ruleId: string;
  ruleName: string;
  rate: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
}

@Injectable()
export class TaxesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
  ) {}

  async createTaxRule(tenantId: string, branchId: string, dto: CreateTaxRuleDto): Promise<TaxRule> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      return tx.taxRule.create({
        data: {
          tenantId,
          branchId,
          name: dto.name,
          rate: new Prisma.Decimal(dto.rate),
          type: DEFAULT_TAX_RULE_TYPE,
          appliesToChargeTypes: dto.appliesToChargeTypes ?? [],
          jurisdiction: dto.jurisdiction,
        },
      });
    });
  }

  async listTaxRules(tenantId: string, branchId: string): Promise<TaxRule[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      return tx.taxRule.findMany({ where: { branchId }, orderBy: { name: 'asc' } });
    });
  }

  /** Retires/reinstates a rule. Never deletes — a deleted rule would orphan the `taxRuleIds` on every historical tax line item that references it. */
  async updateTaxRule(tenantId: string, taxRuleId: string, dto: UpdateTaxRuleDto): Promise<TaxRule> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rule = await tx.taxRule.findFirst({ where: { id: taxRuleId } });
      if (!rule) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Tax rule not found' });
      }
      return tx.taxRule.update({
        where: { id: taxRuleId },
        data: { ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}) },
      });
    });
  }

  /**
   * The tax engine (spec §4.5). Returns one entry per active branch rule
   * that applies to this charge type — `appliesToChargeTypes: []` means
   * "all types", matching the schema's own comment.
   *
   * Takes an already-open transaction so it runs inside the same atomic
   * unit as the charge it's taxing: a charge and its taxes must be written
   * together or not at all.
   *
   * **Rules computing to exactly 0 are skipped**, not returned as zero
   * rows: `line_items` carries a DB-level `CHECK (amount <> 0)` (see
   * `20260712000001_rls_and_constraints`), so a 0.00 tax line would abort
   * the whole transaction. Reachable in practice via a 0%-rate rule or a
   * charge small enough to round to zero.
   */
  async computeTaxesForCharge(
    tx: TenantTx,
    branchId: string,
    chargeType: ChargeType,
    amount: Prisma.Decimal,
  ): Promise<ComputedTax[]> {
    const rules = await tx.taxRule.findMany({ where: { branchId, isActive: true }, orderBy: { name: 'asc' } });

    return rules
      .filter((rule) => rule.appliesToChargeTypes.length === 0 || rule.appliesToChargeTypes.includes(chargeType))
      .map((rule) => ({
        ruleId: rule.id,
        ruleName: rule.name,
        rate: rule.rate,
        // Decimal arithmetic end to end — never floats (spec §6). Money is
        // NUMERIC(12,2), so round to 2dp at the point of computation rather
        // than letting Postgres truncate on insert.
        taxAmount: amount.mul(rule.rate).toDecimalPlaces(2),
      }))
      .filter((computed) => !computed.taxAmount.isZero());
  }
}
