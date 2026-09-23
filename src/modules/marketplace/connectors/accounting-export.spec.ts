import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AccountingConfig,
  JournalInputs,
  buildJournals,
  defaultAccountingConfig,
  formatDate,
  journalPrefixFor,
  parseAccountingConfig,
  toQuickBooksCsv,
  toXeroCsv,
} from './accounting-export';

const d = (value: string) => new Prisma.Decimal(value);
const CONTEXT = { journalPrefix: 'LPH', propertyName: 'Lekki Palms Hotel' };

function config(overrides: Partial<AccountingConfig> = {}): AccountingConfig {
  return { ...defaultAccountingConfig('quickbooks_online'), ...overrides };
}

function lineFor(journal: ReturnType<typeof buildJournals>[number], account: string) {
  return journal.lines.find((line) => line.account === account);
}

describe('accounting-export', () => {
  describe('parseAccountingConfig', () => {
    it('accepts the suggested settings for both products', () => {
      expect(parseAccountingConfig(defaultAccountingConfig('quickbooks_online')).accounts.receivable).toBe('Accounts Receivable (A/R)');
      expect(parseAccountingConfig(defaultAccountingConfig('xero')).accounts.revenue.room).toBe('200');
    });

    it('names the account that is missing', () => {
      const incomplete = defaultAccountingConfig('quickbooks_online');
      incomplete.accounts.payments.card = ' ';
      expect(() => parseAccountingConfig(incomplete)).toThrow('Choose an account for Card payments');
    });

    it('refuses an account a spreadsheet would run as a formula', () => {
      const risky = defaultAccountingConfig('quickbooks_online');
      risky.accounts.revenue.room = '=HYPERLINK("x")';
      expect(() => parseAccountingConfig(risky)).toThrow(BadRequestException);
    });

    it('refuses an unknown date format', () => {
      expect(() => parseAccountingConfig({ ...defaultAccountingConfig('xero'), dateFormat: 'D.M.YY' })).toThrow(/Date format/);
    });
  });

  describe('buildJournals', () => {
    const inputs: JournalInputs = {
      folioLines: [
        { date: '2026-09-15', department: 'room', amount: d('30000') },
        { date: '2026-09-15', department: 'tax', amount: d('2250') },
        { date: '2026-09-15', department: 'fnb', amount: d('5000') },
        { date: '2026-09-15', department: 'tax', amount: d('375') },
      ],
      payments: [
        { date: '2026-09-15', method: 'cash', amount: d('20000') },
        { date: '2026-09-15', method: 'card', amount: d('10000') },
      ],
      posSales: [{ date: '2026-09-15', department: 'fnb', subtotal: d('4000'), total: d('4300'), method: 'cash' }],
    };

    it('produces one balanced journal a day, netting the guest ledger', () => {
      const [journal] = buildJournals(inputs, config(), CONTEXT);
      expect(journal.number).toBe('LPH-20260915');
      expect(journal.totalDebit.toFixed(2)).toBe(journal.totalCredit.toFixed(2));
      // Charges 37,625 on the ledger less 30,000 paid = 7,625 still owed.
      expect(lineFor(journal, 'Accounts Receivable (A/R)')?.debit.toFixed(2)).toBe('7625.00');
      // Cash from the folio and the walk-in sale land in one line.
      expect(lineFor(journal, 'Cash on Hand')?.debit.toFixed(2)).toBe('24300.00');
      expect(lineFor(journal, 'Room Revenue')?.credit.toFixed(2)).toBe('30000.00');
      // Folio F&B and walk-in F&B, both to the same account.
      expect(lineFor(journal, 'Food & Beverage Revenue')?.credit.toFixed(2)).toBe('9000.00');
      expect(lineFor(journal, 'VAT Payable')?.credit.toFixed(2)).toBe('2925.00');
    });

    it('keeps walk-in sales off the guest ledger — they were never on a bill', () => {
      const [journal] = buildJournals({ folioLines: [], payments: [], posSales: inputs.posSales }, config(), CONTEXT);
      expect(lineFor(journal, 'Accounts Receivable (A/R)')).toBeUndefined();
      expect(journal.totalDebit.toFixed(2)).toBe('4300.00');
    });

    it('lets a day of net corrections post as debits to revenue', () => {
      const [journal] = buildJournals({ folioLines: [{ date: '2026-09-16', department: 'room', amount: d('-30000') }], payments: [], posSales: [] }, config(), CONTEXT);
      expect(lineFor(journal, 'Room Revenue')?.debit.toFixed(2)).toBe('30000.00');
      expect(lineFor(journal, 'Accounts Receivable (A/R)')?.credit.toFixed(2)).toBe('30000.00');
    });

    it('treats a refund as money going back out', () => {
      const [journal] = buildJournals({ folioLines: [], payments: [{ date: '2026-09-17', method: 'card', amount: d('-5000') }], posSales: [] }, config(), CONTEXT);
      expect(lineFor(journal, 'Card Clearing')?.credit.toFixed(2)).toBe('5000.00');
      expect(lineFor(journal, 'Accounts Receivable (A/R)')?.debit.toFixed(2)).toBe('5000.00');
    });

    it('skips days where everything nets to nothing, and sorts the days', () => {
      const journals = buildJournals(
        {
          folioLines: [
            { date: '2026-09-20', department: 'misc', amount: d('100') },
            { date: '2026-09-18', department: 'spa', amount: d('500') },
            { date: '2026-09-18', department: 'spa', amount: d('-500') },
          ],
          payments: [],
          posSales: [],
        },
        config(),
        CONTEXT,
      );
      expect(journals.map((journal) => journal.date)).toEqual(['2026-09-20']);
    });

    it('lists debits before credits', () => {
      const [journal] = buildJournals(inputs, config(), CONTEXT);
      const firstCredit = journal.lines.findIndex((line) => line.credit.greaterThan(0));
      expect(journal.lines.slice(firstCredit).every((line) => line.debit.isZero())).toBe(true);
    });
  });

  describe('files', () => {
    const journals = buildJournals(
      {
        folioLines: [{ date: '2026-09-05', department: 'room', amount: d('1000') }],
        payments: [{ date: '2026-09-05', method: 'bank_transfer', amount: d('1000') }],
        posSales: [],
      },
      config({ dateFormat: 'DD/MM/YYYY' }),
      CONTEXT,
    );

    it('writes QuickBooks’ journal-entry columns with separate debit and credit amounts', () => {
      const csv = toQuickBooksCsv(journals, config({ dateFormat: 'MM/DD/YYYY' }));
      const [header, ...rows] = csv.trim().split('\r\n');
      expect(header).toBe('JournalNo,JournalDate,AccountName,Debits,Credits,Description');
      expect(rows).toContain('LPH-20260905,09/05/2026,Bank,1000.00,,Bank transfer received');
      expect(rows).toContain('LPH-20260905,09/05/2026,Room Revenue,,1000.00,Rooms revenue');
    });

    it('writes Xero’s manual-journal columns, debits positive and credits negative', () => {
      const xero = defaultAccountingConfig('xero');
      const csv = toXeroCsv(buildJournals({ folioLines: [{ date: '2026-09-05', department: 'room', amount: d('1000') }], payments: [], posSales: [] }, xero, CONTEXT), xero);
      const [header, ...rows] = csv.trim().split('\r\n');
      expect(header).toBe('*Narration,*Date,Description,*AccountCode,*TaxRate,*Amount,TrackingName1,TrackingOption1,TrackingName2,TrackingOption2');
      expect(rows).toContain('Lekki Palms Hotel — daily takings 2026-09-05,05/09/2026,Guest charges,610,Tax Exempt,1000.00,,,,');
      expect(rows).toContain('Lekki Palms Hotel — daily takings 2026-09-05,05/09/2026,Rooms revenue,200,Tax Exempt,-1000.00,,,,');
    });

    it('quotes a value with a comma in it', () => {
      const withComma = config();
      withComma.accounts.revenue.room = 'Revenue, Rooms';
      const csv = toQuickBooksCsv(buildJournals({ folioLines: [{ date: '2026-09-05', department: 'room', amount: d('10') }], payments: [], posSales: [] }, withComma, CONTEXT), withComma);
      expect(csv).toContain('"Revenue, Rooms"');
    });
  });

  it('formats dates the three ways', () => {
    expect(formatDate('2026-09-05', 'DD/MM/YYYY')).toBe('05/09/2026');
    expect(formatDate('2026-09-05', 'MM/DD/YYYY')).toBe('09/05/2026');
    expect(formatDate('2026-09-05', 'YYYY-MM-DD')).toBe('2026-09-05');
  });

  it('makes a short journal prefix from the property name', () => {
    expect(journalPrefixFor('Lekki Palms Hotel')).toBe('LPH');
    expect(journalPrefixFor('  ')).toBe('PMS');
  });
});
