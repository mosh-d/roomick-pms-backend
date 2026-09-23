import { BadRequestException, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/error-codes';
import { branchDayStart, localDateOf, toBranchDate } from '../../common/utils/branch-date';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import {
  AccountingProvider,
  Journal,
  JournalInputs,
  buildJournals,
  journalPrefixFor,
  parseAccountingConfig,
  toQuickBooksCsv,
  toXeroCsv,
} from './connectors/accounting-export';
import { MarketplaceService } from './marketplace.service';

/** A month at a time. Longer ranges make files an accountant can't eyeball, and importers have row limits. */
const MAX_RANGE_DAYS = 31;

export interface JournalPreview {
  provider: AccountingProvider;
  from: string;
  to: string;
  currency: string;
  property: string;
  journals: Array<{
    date: string;
    number: string;
    lines: Array<{ account: string; debit: string; credit: string; description: string }>;
    totalDebit: string;
    totalCredit: string;
  }>;
  lineCount: number;
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

function addDays(isoDate: string, days: number): string {
  const date = toBranchDate(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Reads a property's takings for a date range and turns them into the
 * journals `buildJournals` balances.
 *
 * The figures follow the Revenue report's own rules, so the two reconcile:
 * charges and tax by the business date they belong to (`serviceDate`), a
 * correction against the department of the charge it reverses, walk-in POS
 * sales from `pos_orders`. Payments and walk-in sales are grouped by the
 * property's own local day — the report now does the same.
 *
 * One consequence worth knowing, and said on the export page: a correction or
 * a back-dated charge belongs to the day of the charge, so it changes that
 * day's journal. Export days once they're settled, and re-export any day that
 * was corrected afterwards. Journal numbers are per property and day, so
 * QuickBooks' duplicate-number warning catches a day imported twice.
 */
@Injectable()
export class AccountingExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    private readonly marketplaceService: MarketplaceService,
  ) {}

  async preview(tenantId: string, branchId: string, provider: AccountingProvider, from: string, to: string): Promise<JournalPreview> {
    const { journals, currency, property } = await this.build(tenantId, branchId, provider, from, to);
    return {
      provider,
      from,
      to,
      currency,
      property,
      journals: journals.map((journal) => ({
        date: journal.date,
        number: journal.number,
        lines: journal.lines.map((line) => ({
          account: line.account,
          debit: line.debit.toFixed(2),
          credit: line.credit.toFixed(2),
          description: line.description,
        })),
        totalDebit: journal.totalDebit.toFixed(2),
        totalCredit: journal.totalCredit.toFixed(2),
      })),
      lineCount: journals.reduce((sum, journal) => sum + journal.lines.length, 0),
    };
  }

  async exportCsv(tenantId: string, branchId: string, provider: AccountingProvider, from: string, to: string): Promise<{ filename: string; csv: string }> {
    const { journals, config, prefix } = await this.build(tenantId, branchId, provider, from, to);
    const csv = provider === 'xero' ? toXeroCsv(journals, config) : toQuickBooksCsv(journals, config);
    const name = provider === 'xero' ? 'xero-manual-journals' : 'quickbooks-journal-entries';
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.integrationConnection.updateMany({
        where: { provider },
        data: { lastRunAt: new Date(), lastRunSummary: `Exported ${journals.length} day${journals.length === 1 ? '' : 's'} (${from} to ${to}) for ${prefix}` },
      }),
    );
    return { filename: `${name}-${prefix}-${from.replace(/-/g, '')}-${to.replace(/-/g, '')}.csv`, csv };
  }

  private async build(tenantId: string, branchId: string, provider: AccountingProvider, from: string, to: string) {
    if (to < from) throw invalid('The end date is before the start date');
    const days = Math.round((toBranchDate(to).getTime() - toBranchDate(from).getTime()) / 86_400_000) + 1;
    if (days > MAX_RANGE_DAYS) throw invalid(`Export up to ${MAX_RANGE_DAYS} days at a time — this range is ${days}`);
    const dayAfter = addDays(to, 1);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const connection = await this.marketplaceService.enabledConnection(tx, provider);
      const config = parseAccountingConfig(connection.config);
      const branch = await this.propertyService.assertBranch(tx, branchId);

      const [lineItems, payments, posSales] = await Promise.all([
        tx.lineItem.findMany({
          // Tax lines included — they're the tax account's side of each day.
          where: { folio: { branchId }, isVoid: false, deletedAt: null, serviceDate: { gte: toBranchDate(from), lt: toBranchDate(dayAfter) } },
          select: { amount: true, chargeType: true, serviceDate: true, correctsLineItem: { select: { chargeType: true } } },
        }),
        tx.payment.findMany({
          where: {
            folio: { branchId },
            isVoid: false,
            deletedAt: null,
            recordedAt: { gte: branchDayStart(from, branch.timezone), lt: branchDayStart(dayAfter, branch.timezone) },
          },
          select: { amount: true, method: true, recordedAt: true },
        }),
        tx.posOrder.findMany({
          where: {
            branchId,
            settlement: { in: ['cash', 'card'] },
            voidedAt: null,
            createdAt: { gte: branchDayStart(from, branch.timezone), lt: branchDayStart(dayAfter, branch.timezone) },
          },
          select: { subtotal: true, total: true, settlement: true, createdAt: true, outlet: { select: { chargeType: true } } },
        }),
      ]);

      const inputs: JournalInputs = {
        folioLines: lineItems
          .filter((line) => line.serviceDate !== null)
          .map((line) => ({
            date: line.serviceDate!.toISOString().slice(0, 10),
            department: line.correctsLineItem?.chargeType ?? line.chargeType,
            amount: line.amount,
          })),
        payments: payments.map((payment) => ({ date: localDateOf(payment.recordedAt, branch.timezone), method: payment.method, amount: payment.amount })),
        posSales: posSales.map((sale) => ({
          date: localDateOf(sale.createdAt, branch.timezone),
          department: sale.outlet.chargeType,
          subtotal: sale.subtotal,
          total: sale.total,
          method: sale.settlement,
        })),
      };

      const prefix = journalPrefixFor(branch.name);
      const journals: Journal[] = buildJournals(inputs, config, { journalPrefix: prefix, propertyName: branch.name });
      return { journals, config, prefix, currency: branch.currency, property: branch.name };
    });
  }
}
