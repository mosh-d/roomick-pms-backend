import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';

export interface ExchangeRateView {
  currency: string;
  /** The branch's currency per one unit of `currency`. */
  rate: string;
  updatedAt: Date;
}

/**
 * The other currencies a branch takes payment in, each with what one unit is
 * worth in the branch's own. A manager keeps them current; a payment keeps
 * the rate it was taken at, so changing a rate never moves a bill already
 * paid.
 */
@Injectable()
export class ExchangeRatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
  ) {}

  async list(tenantId: string, branchId: string): Promise<{ baseCurrency: string; rates: ExchangeRateView[] }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const rates = await tx.exchangeRate.findMany({ where: { branchId }, orderBy: { currency: 'asc' } });
      return { baseCurrency: branch.currency, rates: rates.map((r) => ({ currency: r.currency, rate: r.rate.toString(), updatedAt: r.updatedAt })) };
    });
  }

  async set(tenantId: string, branchId: string, currencyParam: string, rate: number, actorId: string): Promise<ExchangeRateView> {
    const currency = this.currencyCode(currencyParam);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      if (currency === branch.currency) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `${currency} is this branch's own currency — it needs no rate` });
      }
      const before = await tx.exchangeRate.findFirst({ where: { branchId, currency } });
      const value = new Prisma.Decimal(rate);
      const saved = await tx.exchangeRate.upsert({
        where: { branchId_currency: { branchId, currency } },
        create: { tenantId, branchId, currency, rate: value, updatedBy: actorId },
        update: { rate: value, updatedBy: actorId },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId,
          userId: actorId,
          action: 'exchange_rate.set',
          entityType: 'branch',
          entityId: branchId,
          before: before ? { currency, rate: before.rate.toString() } : Prisma.JsonNull,
          after: { currency, rate: saved.rate.toString(), baseCurrency: branch.currency },
        },
      });
      return { currency, rate: saved.rate.toString(), updatedAt: saved.updatedAt };
    });
  }

  async remove(tenantId: string, branchId: string, currencyParam: string, actorId: string): Promise<{ removed: true }> {
    const currency = this.currencyCode(currencyParam);
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const existing = await tx.exchangeRate.findFirst({ where: { branchId, currency } });
      if (!existing) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: `No rate is set for ${currency}` });
      await tx.exchangeRate.delete({ where: { id: existing.id } });
      await tx.auditLog.create({
        data: { tenantId, branchId, userId: actorId, action: 'exchange_rate.removed', entityType: 'branch', entityId: branchId, before: { currency, rate: existing.rate.toString() } },
      });
      return { removed: true };
    });
  }

  private currencyCode(value: string): string {
    const code = value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'A currency is its three-letter code, like USD' });
    return code;
  }
}
