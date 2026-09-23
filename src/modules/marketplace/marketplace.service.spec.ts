import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { AccountingExportService } from './accounting-export.service';
import { defaultAccountingConfig } from './connectors/accounting-export';
import { DEFAULT_REVIEW_REQUEST } from './connectors/review-requests';
import { MarketplaceService } from './marketplace.service';
import { ReviewRequestsService } from './review-requests.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '66666666-6666-4666-8666-666666666666';

function actor(role: string): JwtPayload {
  return { sub: ACTOR_ID, tenantId: TENANT_ID, email: 'staff@example.com', roles: [{ branchId: BRANCH_ID, role }], tokenType: 'access' };
}

const reviewConfig = { ...DEFAULT_REVIEW_REQUEST, links: { [BRANCH_ID]: 'https://g.page/r/lekki/review' } };

describe('Integrations Marketplace', () => {
  let marketplace: MarketplaceService;
  let accounting: AccountingExportService;
  let reviews: ReviewRequestsService;
  let tx: ReturnType<typeof makeTx>;

  function makeTx() {
    return {
      integrationConnection: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      branch: { findMany: jest.fn().mockResolvedValue([{ id: BRANCH_ID, name: 'Lekki Palms Hotel' }]) },
      lineItem: { findMany: jest.fn().mockResolvedValue([]) },
      payment: { findMany: jest.fn().mockResolvedValue([]) },
      posOrder: { findMany: jest.fn().mockResolvedValue([]) },
      reservation: { findMany: jest.fn().mockResolvedValue([]) },
      communicationLog: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
  }

  beforeEach(async () => {
    tx = makeTx();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MarketplaceService,
        AccountingExportService,
        ReviewRequestsService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        {
          provide: PropertyService,
          useValue: { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, name: 'Lekki Palms Hotel', timezone: 'Africa/Lagos', currency: 'NGN' }) },
        },
      ],
    }).compile();
    marketplace = moduleRef.get(MarketplaceService);
    accounting = moduleRef.get(AccountingExportService);
    reviews = moduleRef.get(ReviewRequestsService);
  });

  describe('the catalogue', () => {
    it('lists every entry with its category, and only the categories in use', async () => {
      const view = await marketplace.listCatalog(TENANT_ID);
      expect(view.listings.map((l) => l.key)).toEqual(expect.arrayContaining(['quickbooks_online', 'xero', 'review_requests', 'channel_manager', 'stripe']));
      expect(view.categories.map((c) => c.key)).toContain('accounting');
      expect(view.listings.find((l) => l.key === 'xero')?.categoryLabel).toBe('Accounting');
    });

    it('offers suggested settings until an integration has been set up', async () => {
      const listing = await marketplace.getListing(TENANT_ID, 'xero');
      expect(listing.configured).toBe(false);
      expect(listing.setup.kind).toBe('accounting');
    });

    it('404s an integration that isn’t in the catalogue', async () => {
      await expect(marketplace.getListing(TENANT_ID, 'myspace')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('switching on and off', () => {
    it('refuses to switch on something that is only coming later', async () => {
      await expect(marketplace.saveConnection(TENANT_ID, 'stripe', {}, actor('owner'))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets an accountant set up an accounting export, but not guest emails', async () => {
      await marketplace.saveConnection(TENANT_ID, 'quickbooks_online', defaultAccountingConfig('quickbooks_online'), actor('accountant'));
      expect(tx.integrationConnection.create).toHaveBeenCalled();
      await expect(marketplace.saveConnection(TENANT_ID, 'review_requests', reviewConfig, actor('accountant'))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(marketplace.saveConnection(TENANT_ID, 'quickbooks_online', defaultAccountingConfig('quickbooks_online'), actor('front_desk'))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('validates the settings before saving anything', async () => {
      await expect(marketplace.saveConnection(TENANT_ID, 'review_requests', { ...reviewConfig, links: {} }, actor('manager'))).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.integrationConnection.create).not.toHaveBeenCalled();
    });

    it('switching back on restarts the clock; changing settings of one that is on does not', async () => {
      tx.integrationConnection.findFirst.mockResolvedValue({ id: 'c1', provider: 'review_requests', status: 'disabled', config: reviewConfig, enabledAt: new Date('2026-01-01') });
      await marketplace.saveConnection(TENANT_ID, 'review_requests', reviewConfig, actor('manager'));
      const reEnabled = (tx.integrationConnection.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
      expect(reEnabled).toMatchObject({ status: 'enabled', disabledAt: null });
      expect((reEnabled.enabledAt as Date).getFullYear()).toBeGreaterThan(2025);

      tx.integrationConnection.update.mockClear();
      tx.integrationConnection.findFirst.mockResolvedValue({ id: 'c1', provider: 'review_requests', status: 'enabled', config: reviewConfig, enabledAt: new Date('2026-01-01') });
      await marketplace.saveConnection(TENANT_ID, 'review_requests', { ...reviewConfig, delayHours: 48 }, actor('manager'));
      const reconfigured = (tx.integrationConnection.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
      expect(reconfigured.enabledAt).toBeUndefined();
      expect(reconfigured.status).toBeUndefined();
    });

    it('switching off keeps the settings', async () => {
      tx.integrationConnection.findFirst.mockResolvedValue({ id: 'c1', provider: 'xero', status: 'enabled', config: defaultAccountingConfig('xero'), enabledAt: new Date() });
      await marketplace.disable(TENANT_ID, 'xero', actor('owner'));
      const data = (tx.integrationConnection.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({ status: 'disabled', disabledAt: expect.any(Date) });
      expect(data.config).toBeUndefined();
    });
  });

  describe('accounting export', () => {
    const enabled = { id: 'c1', provider: 'quickbooks_online', status: 'enabled', config: defaultAccountingConfig('quickbooks_online'), enabledAt: new Date() };

    it('refuses until the export is switched on', async () => {
      await expect(accounting.preview(TENANT_ID, BRANCH_ID, 'quickbooks_online', '2026-09-01', '2026-09-02')).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses more than a month at once, and a backwards range', async () => {
      tx.integrationConnection.findFirst.mockResolvedValue(enabled);
      await expect(accounting.preview(TENANT_ID, BRANCH_ID, 'quickbooks_online', '2026-08-01', '2026-09-15')).rejects.toThrow(/up to 31 days/);
      await expect(accounting.preview(TENANT_ID, BRANCH_ID, 'quickbooks_online', '2026-09-15', '2026-09-01')).rejects.toThrow(/before the start/);
    });

    it('files a payment taken at 00:30 in Lagos under that Lagos day, not the UTC one', async () => {
      tx.integrationConnection.findFirst.mockResolvedValue(enabled);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('5000'), method: 'cash', recordedAt: new Date('2026-09-14T23:30:00Z') }]);
      const preview = await accounting.preview(TENANT_ID, BRANCH_ID, 'quickbooks_online', '2026-09-15', '2026-09-15');
      // The window itself is Lagos midnight to Lagos midnight.
      expect((tx.payment.findMany.mock.calls[0][0] as { where: { recordedAt: unknown } }).where.recordedAt).toEqual({
        gte: new Date('2026-09-14T23:00:00Z'),
        lt: new Date('2026-09-15T23:00:00Z'),
      });
      expect(preview.journals.map((j) => j.date)).toEqual(['2026-09-15']);
    });

    it('counts a correction against the department of the charge it reverses', async () => {
      tx.integrationConnection.findFirst.mockResolvedValue(enabled);
      tx.lineItem.findMany.mockResolvedValue([
        { amount: new Prisma.Decimal('5000'), chargeType: 'spa', serviceDate: new Date('2026-09-15'), correctsLineItem: null },
        { amount: new Prisma.Decimal('-5000'), chargeType: 'correction', serviceDate: new Date('2026-09-15'), correctsLineItem: { chargeType: 'spa' } },
        { amount: new Prisma.Decimal('1000'), chargeType: 'room', serviceDate: new Date('2026-09-15'), correctsLineItem: null },
      ]);
      const preview = await accounting.preview(TENANT_ID, BRANCH_ID, 'quickbooks_online', '2026-09-15', '2026-09-15');
      const accounts = preview.journals[0].lines.map((l) => l.account);
      // The spa charge and its reversal cancel out; nothing lands on the corrections account.
      expect(accounts).toEqual(['Accounts Receivable (A/R)', 'Room Revenue']);
    });

    it('names the file after the product, the property and the range, and records the run', async () => {
      tx.integrationConnection.findFirst.mockResolvedValue(enabled);
      const { filename, csv } = await accounting.exportCsv(TENANT_ID, BRANCH_ID, 'quickbooks_online', '2026-09-01', '2026-09-15');
      expect(filename).toBe('quickbooks-journal-entries-LPH-20260901-20260915.csv');
      expect(csv.startsWith('JournalNo,JournalDate,AccountName,Debits,Credits,Description')).toBe(true);
      expect(tx.integrationConnection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastRunAt: expect.any(Date) }) }));
    });
  });

  describe('review requests', () => {
    const now = new Date('2026-09-22T12:00:00Z');
    const enabled = { id: 'c2', provider: 'review_requests', status: 'enabled', config: reviewConfig, enabledAt: new Date('2026-09-20T00:00:00Z') };

    it('does nothing while switched off', async () => {
      expect(await reviews.sendDueForTenant(TENANT_ID, now)).toBe(0);
      expect(tx.reservation.findMany).not.toHaveBeenCalled();
    });

    it('asks only stays that ended in the window, at a property with a link, from guests who can be emailed and haven’t been asked', async () => {
      tx.integrationConnection.findFirst.mockResolvedValue(enabled);
      await reviews.sendDueForTenant(TENANT_ID, now);
      const where = (tx.reservation.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
      expect(where).toMatchObject({
        branchId: { in: [BRANCH_ID] },
        status: 'checked_out',
        actualCheckOut: { gte: enabled.enabledAt, lte: new Date('2026-09-21T12:00:00Z') },
        guest: { deletedAt: null, email: { not: null }, marketingUnsubscribedAt: null },
        communicationLogs: { none: { trigger: 'review_request' } },
      });
    });

    it('queues one email per stay, attached to the stay, and notes the run', async () => {
      tx.integrationConnection.findFirst.mockResolvedValue(enabled);
      tx.reservation.findMany.mockResolvedValue([{ id: 'res-1', branchId: BRANCH_ID, guestId: 'guest-1', guest: { name: 'Kemi Adeyemi' } }]);
      expect(await reviews.sendDueForTenant(TENANT_ID, now)).toBe(1);
      const data = (tx.communicationLog.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({ reservationId: 'res-1', guestId: 'guest-1', trigger: 'review_request', channel: 'email', deliveryStatus: 'queued', subject: 'Thank you for staying at Lekki Palms Hotel' });
      expect(String(data.body)).toContain('https://g.page/r/lekki/review');
      expect(tx.integrationConnection.update).toHaveBeenCalledWith({ where: { id: 'c2' }, data: { lastRunAt: now, lastRunSummary: 'Asked 1 guest for a review' } });
    });

    it('asks nobody straight after being switched on', async () => {
      tx.integrationConnection.findFirst.mockResolvedValue({ ...enabled, enabledAt: new Date('2026-09-22T11:00:00Z') });
      expect(await reviews.sendDueForTenant(TENANT_ID, now)).toBe(0);
      expect(tx.reservation.findMany).not.toHaveBeenCalled();
    });
  });
});
