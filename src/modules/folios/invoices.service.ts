import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Invoice, Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { FoliosService } from './folios.service';
import { renderInvoicePdf } from './invoice-pdf.util';

export interface InvoiceLine {
  date: string | null;
  description: string;
  chargeType: string;
  amount: string;
  /** Tax posted with this charge. */
  tax: string;
}

export interface InvoicePayment {
  date: string;
  method: string;
  amount: string;
  reference: string | null;
  /** Paid in another currency: what was handed over, and at what rate. */
  foreign: { currency: string; amount: string; rate: string } | null;
}

export interface InvoiceTotals {
  subTotal: string;
  taxTotal: string;
  total: string;
  paid: string;
  balanceDue: string;
  taxes: Array<{ name: string; amount: string }>;
  payments: InvoicePayment[];
}

export interface InvoiceBillTo {
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export interface InvoiceView {
  id: string;
  folioId: string;
  number: string;
  issuedAt: Date;
  dueDate: string | null;
  currency: string;
  billTo: InvoiceBillTo;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  supersededAt: Date | null;
  supersedes: { id: string; number: string } | null;
  supersededBy: { id: string; number: string } | null;
}

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  voucher: 'Voucher',
  loyalty_points: 'Loyalty points',
};

const INVOICE_LINKS = { supersedes: { select: { id: true, number: true } }, supersededBy: { select: { id: true, number: true } } } as const;
type InvoiceWithLinks = Invoice & { supersedes: { id: string; number: string } | null; supersededBy: { id: string; number: string } | null };

/**
 * Invoices: a numbered record of a bill for the guest or the company paying
 * it. Each property numbers its own in sequence (INV-2026-00001). An invoice
 * is a snapshot — the lines, totals and payments as they stood when issued —
 * so it reads the same however the bill changes after. Issuing again after
 * the bill changed gives a new number that replaces the old one, which is
 * kept and marked replaced; issuing again when nothing changed gives back the
 * same invoice rather than a second number for one bill.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foliosService: FoliosService,
    private readonly propertyService: PropertyService,
  ) {}

  async issue(tenantId: string, folioId: string, actorId: string): Promise<InvoiceView> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      // One issue at a time per bill: two at once would number the same bill twice.
      await tx.$queryRaw`SELECT id FROM folios WHERE id = ${folioId}::uuid FOR UPDATE`;
      const folio = await tx.folio.findFirst({
        where: { id: folioId, deletedAt: null },
        include: { guest: true, corporateAccount: true, reservation: { select: { status: true } } },
      });
      if (!folio) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Folio not found' });
      if (folio.status === 'pending') {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This bill only holds a deposit until the guest arrives — there is nothing to invoice yet' });
      }
      const branch = await this.propertyService.assertBranch(tx, folio.branchId);
      const { lines, totals } = await this.snapshot(tx, folioId, branch.timezone);

      const current = await tx.invoice.findFirst({ where: { folioId, supersededAt: null }, orderBy: { issuedAt: 'desc' }, include: INVOICE_LINKS });
      // Compared key-order-free: the stored copy comes back from a JSONB column, which reorders keys.
      if (current && canonical(current.lines) === canonical(lines) && canonical(current.totals) === canonical(totals)) {
        return this.view(current);
      }

      const [{ invoiceSeq }] = await tx.$queryRaw<Array<{ invoiceSeq: number }>>`
        UPDATE branches SET "invoiceSeq" = "invoiceSeq" + 1 WHERE id = ${branch.id}::uuid RETURNING "invoiceSeq"`;
      const today = todayInTimezone(branch.timezone);
      const number = `INV-${today.slice(0, 4)}-${String(invoiceSeq).padStart(5, '0')}`;
      const terms = folio.corporateAccount?.paymentTermsDays ?? null;
      const dueDate = terms !== null ? new Date(toBranchDate(today).getTime() + terms * 86_400_000) : null;

      if (current) await tx.invoice.update({ where: { id: current.id }, data: { supersededAt: new Date() } });
      const created = await tx.invoice.create({
        data: {
          tenantId,
          branchId: branch.id,
          folioId,
          number,
          billTo: this.billTo(folio) as unknown as Prisma.InputJsonValue,
          lines: lines as unknown as Prisma.InputJsonValue,
          totals: totals as unknown as Prisma.InputJsonValue,
          currency: branch.currency,
          dueDate,
          issuedBy: actorId,
          supersedesId: current?.id,
        },
        include: INVOICE_LINKS,
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId: branch.id,
          userId: actorId,
          action: 'invoice.issued',
          entityType: 'folio',
          entityId: folioId,
          after: { number, total: totals.total, balanceDue: totals.balanceDue, ...(current ? { replaces: current.number } : {}) },
        },
      });
      return this.view(created);
    });
  }

  async listForFolio(tenantId: string, folioId: string): Promise<InvoiceView[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const invoices = await tx.invoice.findMany({ where: { folioId }, orderBy: { issuedAt: 'desc' }, include: INVOICE_LINKS });
      return invoices.map((invoice) => this.view(invoice));
    });
  }

  async pdf(tenantId: string, invoiceId: string): Promise<{ filename: string; pdf: Buffer }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId },
        include: {
          ...INVOICE_LINKS,
          folio: {
            select: {
              reservation: {
                select: {
                  confirmationNumber: true,
                  checkInDate: true,
                  checkOutDate: true,
                  guest: { select: { name: true } },
                  room: { select: { number: true } },
                  roomType: { select: { name: true } },
                },
              },
            },
          },
        },
      });
      if (!invoice) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Invoice not found' });
      const branch = await this.propertyService.assertBranch(tx, invoice.branchId);
      const view = this.view(invoice);
      const stay = invoice.folio.reservation;
      const day = (value: Date | string) =>
        new Date(typeof value === 'string' ? `${value.slice(0, 10)}T00:00:00.000Z` : value).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
      const money = (value: string) => Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const pdf = await renderInvoicePdf({
        propertyName: branch.name,
        propertyAddress: addressLine(branch.address),
        number: view.number,
        issuedOn: view.issuedAt.toLocaleDateString('en-GB', { timeZone: branch.timezone, day: 'numeric', month: 'short', year: 'numeric' }),
        dueOn: view.dueDate ? day(view.dueDate) : null,
        replaces: view.supersedes?.number ?? null,
        replacedBy: view.supersededBy?.number ?? null,
        billTo: [view.billTo.company, view.billTo.company ? `Attn: ${view.billTo.name}` : view.billTo.name, view.billTo.address, view.billTo.email, view.billTo.phone].filter(
          (line): line is string => Boolean(line),
        ),
        stay: stay
          ? [
              `Guest: ${stay.guest.name}`,
              `Booking: ${stay.confirmationNumber}`,
              `Room: ${stay.room ? `${stay.room.number} (${stay.roomType.name})` : stay.roomType.name}`,
              `${day(stay.checkInDate)} – ${day(stay.checkOutDate)}`,
            ]
          : [],
        currency: view.currency,
        lines: view.lines.map((line) => ({ date: line.date ? day(line.date) : '', description: line.description, amount: money(line.amount), tax: Number(line.tax) ? money(line.tax) : '' })),
        subTotal: money(view.totals.subTotal),
        taxes: view.totals.taxes.map((tax) => ({ name: tax.name, amount: money(tax.amount) })),
        total: money(view.totals.total),
        payments: view.totals.payments.map((payment) => ({
          date: day(payment.date),
          description: `${Number(payment.amount) < 0 ? 'Refund' : (METHOD_LABELS[payment.method] ?? payment.method)}${payment.reference ? ` (${payment.reference})` : ''}${
            payment.foreign ? ` — ${payment.foreign.currency} ${money(payment.foreign.amount)} at ${payment.foreign.rate}` : ''
          }`,
          amount: money(payment.amount),
        })),
        paid: money(view.totals.paid),
        balanceDue: money(view.totals.balanceDue),
      });
      return { filename: `${view.number}.pdf`, pdf };
    });
  }

  /** The bill as it stands: its charges with their tax, the taxes added up by rule, and what has been paid. */
  private async snapshot(tx: TenantTx, folioId: string, timezone: string): Promise<{ lines: InvoiceLine[]; totals: InvoiceTotals }> {
    const [items, payments, totals] = await Promise.all([
      tx.lineItem.findMany({ where: { folioId, isVoid: false, deletedAt: null }, orderBy: [{ serviceDate: 'asc' }, { postedAt: 'asc' }] }),
      tx.payment.findMany({ where: { folioId, isVoid: false, deletedAt: null }, orderBy: { recordedAt: 'asc' } }),
      this.foliosService.totalsInTx(tx, folioId),
    ]);
    const ruleIds = [...new Set(items.filter((item) => item.chargeType === 'tax').flatMap((item) => item.taxRuleIds))];
    const rules = ruleIds.length ? await tx.taxRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true } }) : [];
    const ruleName = new Map(rules.map((rule) => [rule.id, rule.name]));

    const taxOf = new Map<string, Prisma.Decimal>();
    const byRule = new Map<string, Prisma.Decimal>();
    const lines: InvoiceLine[] = [];
    for (const item of items) {
      if (item.chargeType !== 'tax') continue;
      if (item.parentLineItemId) taxOf.set(item.parentLineItemId, (taxOf.get(item.parentLineItemId) ?? new Prisma.Decimal(0)).plus(item.amount));
      const name = ruleName.get(item.taxRuleIds[0] ?? '') ?? 'Tax';
      byRule.set(name, (byRule.get(name) ?? new Prisma.Decimal(0)).plus(item.amount));
    }
    for (const item of items) {
      if (item.chargeType === 'tax' && item.parentLineItemId) continue;
      lines.push({
        date: item.serviceDate ? item.serviceDate.toISOString().slice(0, 10) : null,
        description: item.description,
        chargeType: item.chargeType,
        amount: item.amount.toFixed(2),
        tax: item.chargeType === 'tax' ? '0.00' : (taxOf.get(item.id) ?? new Prisma.Decimal(0)).toFixed(2),
      });
    }
    return {
      lines,
      totals: {
        subTotal: totals.subTotal.toFixed(2),
        taxTotal: totals.taxTotal.toFixed(2),
        total: totals.totalCost.toFixed(2),
        paid: totals.paymentsTotal.toFixed(2),
        balanceDue: totals.balanceDue.toFixed(2),
        taxes: [...byRule.entries()].filter(([, amount]) => !amount.isZero()).map(([name, amount]) => ({ name, amount: amount.toFixed(2) })),
        payments: payments.map((payment) => ({
          date: payment.recordedAt.toLocaleDateString('en-CA', { timeZone: timezone }),
          method: payment.method,
          amount: payment.amount.toFixed(2),
          reference: payment.reference,
          foreign:
            payment.foreignCurrency && payment.foreignAmount && payment.exchangeRate
              ? { currency: payment.foreignCurrency, amount: payment.foreignAmount.toFixed(2), rate: payment.exchangeRate.toString() }
              : null,
        })),
      },
    };
  }

  /** Who the invoice is made out to: the company paying, or whoever the bill names, or the guest. */
  private billTo(folio: {
    payerName: string | null;
    payerEmail: string | null;
    guest: { name: string; email: string | null; phone: string | null };
    corporateAccount: { name: string; contactName: string | null; contactEmail: string | null; billingInfo: Prisma.JsonValue } | null;
  }): InvoiceBillTo {
    const company = folio.corporateAccount;
    if (company) {
      const billing = company.billingInfo && typeof company.billingInfo === 'object' && !Array.isArray(company.billingInfo) ? (company.billingInfo as Record<string, unknown>) : {};
      return {
        name: folio.payerName ?? company.contactName ?? folio.guest.name,
        company: company.name,
        email: company.contactEmail ?? folio.payerEmail ?? folio.guest.email,
        phone: null,
        address: typeof billing.address === 'string' && billing.address.trim() ? billing.address.trim() : null,
      };
    }
    return { name: folio.payerName ?? folio.guest.name, company: null, email: folio.payerEmail ?? folio.guest.email, phone: folio.guest.phone, address: null };
  }

  private view(invoice: InvoiceWithLinks): InvoiceView {
    return {
      id: invoice.id,
      folioId: invoice.folioId,
      number: invoice.number,
      issuedAt: invoice.issuedAt,
      dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
      currency: invoice.currency,
      billTo: invoice.billTo as unknown as InvoiceBillTo,
      lines: invoice.lines as unknown as InvoiceLine[],
      totals: invoice.totals as unknown as InvoiceTotals,
      supersededAt: invoice.supersededAt,
      supersedes: invoice.supersedes,
      supersededBy: invoice.supersededBy,
    };
  }
}

/** JSON with every object's keys in one order — two snapshots compare equal when their content is. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(value));
}

/** `{street, city, state, country, zip}` as one line. */
export function addressLine(address: Prisma.JsonValue): string | null {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return null;
  const parts = ['street', 'city', 'state', 'zip', 'country'].map((key) => (address as Record<string, unknown>)[key]).filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return parts.length ? parts.join(', ') : null;
}
