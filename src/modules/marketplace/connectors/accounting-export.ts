import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '../../../common/errors/error-codes';

/**
 * Daily takings as double-entry journals, for QuickBooks Online and Xero.
 *
 * Deliberately an EXPORT, not a live connection: the hotelier downloads a
 * file and imports it with the accounting product's own journal importer.
 * No OAuth app, no stored tokens, nothing for a developer to register — which
 * is what lets a hotelier switch it on themselves. A live API sync is the
 * upgrade, behind the same journal this builds.
 *
 * Everything here is pure: journals are built from rows the service has
 * already read, so the balancing rule can be tested without a database.
 */

export const ACCOUNTING_PROVIDERS = ['quickbooks_online', 'xero'] as const;
export type AccountingProvider = (typeof ACCOUNTING_PROVIDERS)[number];

/** Every `ChargeType` except `tax`, which goes to the tax account instead. `correction` is only for corrections with no original to follow. */
export const REVENUE_DEPARTMENTS = ['room', 'fnb', 'spa', 'laundry', 'minibar', 'transport', 'penalty', 'misc', 'correction'] as const;
export type RevenueDepartment = (typeof REVENUE_DEPARTMENTS)[number];

export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'voucher', 'loyalty_points'] as const;
export type PaymentMethodKey = (typeof PAYMENT_METHODS)[number];

export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const DEPARTMENT_LABELS: Record<RevenueDepartment, string> = {
  room: 'Rooms',
  fnb: 'Food & beverage',
  spa: 'Spa',
  laundry: 'Laundry',
  minibar: 'Minibar',
  transport: 'Transport',
  penalty: 'Cancellation & no-show fees',
  misc: 'Other charges',
  correction: 'Corrections',
};

export const METHOD_LABELS: Record<PaymentMethodKey, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  voucher: 'Voucher',
  loyalty_points: 'Loyalty points',
};

/**
 * One account per thing that moves. QuickBooks matches journal lines by
 * account NAME (a sub-account as "Parent:Child"); Xero by account CODE — the
 * same field holds whichever the provider needs.
 *
 * There is ONE receivable (guest ledger) account, deposits included: a
 * deposit is a payment against the guest's ledger that sits there as a
 * credit until the stay's charges land against it. A separate deposits
 * account would need a later entry moving each deposit out of it, and
 * nothing in the PMS marks that moment — so it would only ever grow.
 */
export interface AccountingConfig {
  dateFormat: DateFormat;
  accounts: {
    receivable: string;
    taxPayable: string;
    revenue: Record<RevenueDepartment, string>;
    payments: Record<PaymentMethodKey, string>;
  };
  /** Xero only: the tax rate every journal line carries. Tax is already its own line, so this is the organisation's "no tax" rate. */
  xeroTaxRate: string;
}

export function defaultAccountingConfig(provider: AccountingProvider): AccountingConfig {
  if (provider === 'xero') {
    // Xero's default chart of accounts uses codes; these are the usual ones
    // and the form asks the hotelier to check them against their own.
    return {
      dateFormat: 'DD/MM/YYYY',
      accounts: {
        receivable: '610',
        taxPayable: '820',
        revenue: { room: '200', fnb: '200', spa: '200', laundry: '200', minibar: '200', transport: '200', penalty: '260', misc: '260', correction: '260' },
        payments: { cash: '090', card: '090', bank_transfer: '090', voucher: '260', loyalty_points: '260' },
      },
      xeroTaxRate: 'Tax Exempt',
    };
  }
  return {
    dateFormat: 'DD/MM/YYYY',
    accounts: {
      receivable: 'Accounts Receivable (A/R)',
      taxPayable: 'VAT Payable',
      revenue: {
        room: 'Room Revenue',
        fnb: 'Food & Beverage Revenue',
        spa: 'Other Revenue',
        laundry: 'Other Revenue',
        minibar: 'Food & Beverage Revenue',
        transport: 'Other Revenue',
        penalty: 'Other Revenue',
        misc: 'Other Revenue',
        correction: 'Other Revenue',
      },
      payments: { cash: 'Cash on Hand', card: 'Card Clearing', bank_transfer: 'Bank', voucher: 'Vouchers Redeemed', loyalty_points: 'Loyalty Redemptions' },
    },
    xeroTaxRate: 'Tax Exempt',
  };
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

/**
 * An account reference as it will appear in the CSV. It is refused if it
 * starts with a character a spreadsheet would run as a formula
 * (`=`, `+`, `@`): the file is meant to be opened, and "fixing" the value by
 * escaping it would stop it matching the real account on import.
 */
function account(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`Choose an account for ${label}`);
  const trimmed = value.trim();
  if (trimmed.length > 100) throw invalid(`The account for ${label} is longer than 100 characters`);
  if (/^[=+@\t\r]/.test(trimmed)) throw invalid(`The account for ${label} can't start with “${trimmed[0]}”`);
  return trimmed;
}

/** Strict on every write and read, like segment criteria: an account left out would unbalance nothing but post to the wrong place. */
export function parseAccountingConfig(value: unknown): AccountingConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('Accounting settings must be an object');
  const raw = value as Record<string, unknown>;
  const dateFormat = raw.dateFormat;
  if (typeof dateFormat !== 'string' || !(DATE_FORMATS as readonly string[]).includes(dateFormat)) {
    throw invalid(`Date format must be one of ${DATE_FORMATS.join(', ')}`);
  }
  const accounts = (raw.accounts ?? {}) as Record<string, unknown>;
  const revenueRaw = (accounts.revenue ?? {}) as Record<string, unknown>;
  const paymentsRaw = (accounts.payments ?? {}) as Record<string, unknown>;

  const revenue = Object.fromEntries(REVENUE_DEPARTMENTS.map((dept) => [dept, account(revenueRaw[dept], `${DEPARTMENT_LABELS[dept]} revenue`)])) as Record<RevenueDepartment, string>;
  const payments = Object.fromEntries(PAYMENT_METHODS.map((method) => [method, account(paymentsRaw[method], `${METHOD_LABELS[method]} payments`)])) as Record<PaymentMethodKey, string>;

  const xeroTaxRate = typeof raw.xeroTaxRate === 'string' && raw.xeroTaxRate.trim() ? raw.xeroTaxRate.trim().slice(0, 50) : 'Tax Exempt';

  return {
    dateFormat: dateFormat as DateFormat,
    accounts: {
      receivable: account(accounts.receivable, 'the guest ledger (receivable)'),
      taxPayable: account(accounts.taxPayable, 'tax collected'),
      revenue,
      payments,
    },
    xeroTaxRate,
  };
}

// ---------------------------------------------------------------------------
// Building the journals
// ---------------------------------------------------------------------------

/** What the service reads, already sorted into branch-local days and departments. */
export interface JournalInputs {
  /** Folio lines, by business date. `department` is the charge type, or the original's for a correction; `tax` for tax lines. */
  folioLines: Array<{ date: string; department: string; amount: Prisma.Decimal }>;
  /** Folio payments (refunds are negative), by the local day they were recorded. */
  payments: Array<{ date: string; method: string; amount: Prisma.Decimal }>;
  /** Walk-in Point of Sale sales settled on the spot — never on a folio, so they don't touch the guest ledger. */
  posSales: Array<{ date: string; department: string; subtotal: Prisma.Decimal; total: Prisma.Decimal; method: string }>;
}

export interface JournalLine {
  account: string;
  /** Exactly one of debit/credit is non-zero. */
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  description: string;
}

export interface Journal {
  date: string;
  number: string;
  narration: string;
  lines: JournalLine[];
  totalDebit: Prisma.Decimal;
  totalCredit: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);

/**
 * One balanced journal per day with any activity.
 *
 *  - Folio charges: Dr guest ledger, Cr each department's revenue, Cr tax.
 *  - Folio payments: Dr the method's account, Cr guest ledger.
 *  - Walk-in POS sales: Dr the method's account, Cr revenue, Cr tax — they
 *    never pass through the guest ledger because they were never on a bill.
 *
 * Lines are then netted per account: a day's charges and payments both touch
 * the guest ledger, and one line for its net movement is what an importer
 * expects. Netting can't unbalance a journal — every movement was entered
 * with its opposite — and the totals are checked anyway before anything is
 * returned.
 */
export function buildJournals(inputs: JournalInputs, config: AccountingConfig, context: { journalPrefix: string; propertyName: string }): Journal[] {
  // account -> { net (debit positive), descriptions }
  const days = new Map<string, Map<string, { net: Prisma.Decimal; labels: Set<string> }>>();
  const post = (date: string, accountName: string, debitPositive: Prisma.Decimal, label: string) => {
    if (debitPositive.isZero()) return;
    const day = days.get(date) ?? new Map<string, { net: Prisma.Decimal; labels: Set<string> }>();
    days.set(date, day);
    const entry = day.get(accountName) ?? { net: ZERO, labels: new Set<string>() };
    entry.net = entry.net.plus(debitPositive);
    entry.labels.add(label);
    day.set(accountName, entry);
  };
  const revenueAccount = (department: string) =>
    (REVENUE_DEPARTMENTS as readonly string[]).includes(department) ? config.accounts.revenue[department as RevenueDepartment] : config.accounts.revenue.misc;
  const revenueLabel = (department: string) =>
    (REVENUE_DEPARTMENTS as readonly string[]).includes(department) ? `${DEPARTMENT_LABELS[department as RevenueDepartment]} revenue` : 'Other revenue';
  const paymentAccount = (method: string) =>
    (PAYMENT_METHODS as readonly string[]).includes(method) ? config.accounts.payments[method as PaymentMethodKey] : config.accounts.payments.cash;
  const paymentLabel = (method: string) => ((PAYMENT_METHODS as readonly string[]).includes(method) ? METHOD_LABELS[method as PaymentMethodKey] : method);

  for (const line of inputs.folioLines) {
    post(line.date, config.accounts.receivable, line.amount, 'Guest charges');
    if (line.department === 'tax') post(line.date, config.accounts.taxPayable, line.amount.negated(), 'Tax collected');
    else post(line.date, revenueAccount(line.department), line.amount.negated(), revenueLabel(line.department));
  }
  for (const payment of inputs.payments) {
    post(payment.date, paymentAccount(payment.method), payment.amount, `${paymentLabel(payment.method)} received`);
    post(payment.date, config.accounts.receivable, payment.amount.negated(), 'Guest payments');
  }
  for (const sale of inputs.posSales) {
    post(sale.date, paymentAccount(sale.method), sale.total, `${paymentLabel(sale.method)} received (walk-in sales)`);
    post(sale.date, revenueAccount(sale.department), sale.subtotal.negated(), `${revenueLabel(sale.department)} (walk-in sales)`);
    post(sale.date, config.accounts.taxPayable, sale.total.minus(sale.subtotal).negated(), 'Tax collected');
  }

  const journals: Journal[] = [];
  for (const date of [...days.keys()].sort()) {
    const lines: JournalLine[] = [];
    for (const [accountName, entry] of [...days.get(date)!.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (entry.net.isZero()) continue;
      const debit = entry.net.greaterThan(0) ? entry.net : ZERO;
      const credit = entry.net.lessThan(0) ? entry.net.negated() : ZERO;
      lines.push({ account: accountName, debit, credit, description: [...entry.labels].join('; ') });
    }
    if (lines.length === 0) continue;
    // Debits first, the way a journal is read.
    lines.sort((a, b) => Number(b.debit.greaterThan(0)) - Number(a.debit.greaterThan(0)));
    const totalDebit = lines.reduce((sum, line) => sum.plus(line.debit), ZERO);
    const totalCredit = lines.reduce((sum, line) => sum.plus(line.credit), ZERO);
    if (!totalDebit.equals(totalCredit)) {
      // Unreachable by construction; refusing beats handing an accountant a journal that won't post.
      throw new Error(`Journal for ${date} does not balance: ${totalDebit.toFixed(2)} debit vs ${totalCredit.toFixed(2)} credit`);
    }
    journals.push({
      date,
      number: `${context.journalPrefix}-${date.replace(/-/g, '')}`,
      narration: `${context.propertyName} — daily takings ${date}`,
      lines,
      totalDebit,
      totalCredit,
    });
  }
  return journals;
}

/** "Lekki Palms Hotel" → "LPH". Keeps journal numbers short, readable, and distinct between properties posting to one company file. */
export function journalPrefixFor(propertyName: string): string {
  const initials = propertyName
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, '').charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 6);
  return initials || 'PMS';
}

// ---------------------------------------------------------------------------
// The two file formats
// ---------------------------------------------------------------------------

export function formatDate(isoDate: string, format: DateFormat): string {
  const [year, month, day] = isoDate.split('-');
  if (format === 'DD/MM/YYYY') return `${day}/${month}/${year}`;
  if (format === 'MM/DD/YYYY') return `${month}/${day}/${year}`;
  return isoDate;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(',');
}

/**
 * QuickBooks Online's journal-entry import: one row per line, the lines of an
 * entry sharing its Journal No. Debits and credits are separate positive
 * columns. QuickBooks asks for the columns to be mapped on import, and these
 * are the names its own sample file uses.
 */
export function toQuickBooksCsv(journals: Journal[], config: AccountingConfig): string {
  const rows = [csvRow(['JournalNo', 'JournalDate', 'AccountName', 'Debits', 'Credits', 'Description'])];
  for (const journal of journals) {
    for (const line of journal.lines) {
      rows.push(
        csvRow([
          journal.number,
          formatDate(journal.date, config.dateFormat),
          line.account,
          line.debit.isZero() ? '' : line.debit.toFixed(2),
          line.credit.isZero() ? '' : line.credit.toFixed(2),
          line.description,
        ]),
      );
    }
  }
  return rows.join('\r\n') + '\r\n';
}

/**
 * Xero's manual-journal import template: the starred columns are required,
 * debits are positive and credits negative, and rows sharing a narration and
 * date form one journal. Both are repeated on every row rather than left
 * blank after the first, which Xero also accepts and which survives someone
 * sorting the file.
 */
export function toXeroCsv(journals: Journal[], config: AccountingConfig): string {
  const rows = [csvRow(['*Narration', '*Date', 'Description', '*AccountCode', '*TaxRate', '*Amount', 'TrackingName1', 'TrackingOption1', 'TrackingName2', 'TrackingOption2'])];
  for (const journal of journals) {
    for (const line of journal.lines) {
      const amount = line.debit.isZero() ? line.credit.negated() : line.debit;
      rows.push(csvRow([journal.narration, formatDate(journal.date, config.dateFormat), line.description, line.account, config.xeroTaxRate, amount.toFixed(2), '', '', '', '']));
    }
  }
  return rows.join('\r\n') + '\r\n';
}
