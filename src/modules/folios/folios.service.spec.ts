import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { TaxesService } from '../taxes/taxes.service';
import { WebhookEventsService } from '../integrations/webhook-events.service';
import { FoliosService } from './folios.service';

/** Webhook events are raised from the same audit calls these tests exercise; what they send is `WebhookEventsService`'s own spec. */
const webhookEvents = { reservationChanged: jest.fn().mockResolvedValue(undefined), paymentRecorded: jest.fn().mockResolvedValue(undefined) };

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const FOLIO_ID = '99999999-9999-4999-8999-999999999999';
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';

function folio(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: FOLIO_ID, tenantId: TENANT_ID, branchId: BRANCH_ID, reservationId: RESERVATION_ID, status: 'open', label: null, deletedAt: null, ...overrides };
}

function reservation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RESERVATION_ID,
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    guestId: 'guest-1',
    confirmedRate: new Prisma.Decimal('300'), // 3 nights x 100
    overrideRate: null,
    checkInDate: new Date('2026-09-01T00:00:00.000Z'),
    checkOutDate: new Date('2026-09-04T00:00:00.000Z'),
    roomType: { name: 'Deluxe Room' },
    ...overrides,
  };
}

type TaxStub = { ruleId: string; ruleName: string; rate: Prisma.Decimal; taxAmount: Prisma.Decimal; inclusive?: boolean };

/** What `TaxesService.priceCharge` returns for `price` with these taxes computed on it. */
function priced(price: Prisma.Decimal | string, taxes: TaxStub[] = []) {
  const amount = new Prisma.Decimal(price);
  const full = taxes.map((tax) => ({ type: 'percentage', fixedAmount: null, inclusive: false, ...tax }));
  const sum = (list: typeof full) => list.reduce((total, tax) => total.plus(tax.taxAmount), new Prisma.Decimal(0));
  const includedTax = sum(full.filter((tax) => tax.inclusive));
  const addedTax = sum(full.filter((tax) => !tax.inclusive));
  return { price: amount, net: amount.minus(includedTax), taxes: full, taxTotal: includedTax.plus(addedTax), includedTax, addedTax, total: amount.plus(addedTax) };
}

function makeTx() {
  return {
    folio: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue(folio()), update: jest.fn().mockResolvedValue(folio({ status: 'settled' })) },
    lineItem: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'li-1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    payment: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'pay-1' }) },
    folioTransfer: {
      create: jest.fn().mockResolvedValue({ id: 'transfer-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'transfer-1', ...data })),
    },
    posOrder: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    reservation: { findFirst: jest.fn().mockResolvedValue(null) },
    corporateAccount: { findFirst: jest.fn().mockResolvedValue(null) },
    taxRule: { findMany: jest.fn().mockResolvedValue([]) },
    shift: { findFirst: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('FoliosService', () => {
  let service: FoliosService;
  let tx: ReturnType<typeof makeTx>;
  let taxesService: { priceCharge: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    taxesService = { priceCharge: jest.fn((_tx: unknown, _branchId: string, _type: string, price: Prisma.Decimal) => Promise.resolve(priced(price))) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        FoliosService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: PropertyService, useValue: { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, timezone: 'Africa/Lagos', currency: 'NGN' }) } },
        { provide: TaxesService, useValue: taxesService },
        { provide: WebhookEventsService, useValue: webhookEvents },
      ],
    }).compile();
    service = moduleRef.get(FoliosService);
  });

  describe('ensurePrimaryFolio', () => {
    it('returns the existing primary folio instead of creating a second one', async () => {
      tx.folio.findFirst.mockResolvedValue(folio());
      const result = await service.ensurePrimaryFolio(tx as never, reservation() as never, ACTOR_ID);
      expect(result.id).toBe(FOLIO_ID);
      expect(tx.folio.create).not.toHaveBeenCalled();
    });

    it('creates an open folio when none exists yet (covers reservations checked in before this module)', async () => {
      tx.folio.findFirst.mockResolvedValue(null);
      await service.ensurePrimaryFolio(tx as never, reservation() as never, ACTOR_ID);
      expect(tx.folio.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'open', reservationId: RESERVATION_ID }) }),
      );
    });
  });

  describe('postRoomChargeForDate — accrual', () => {
    it("bills a night at its own quoted price when the stay keeps one — a 100 + 150 stay posts 150 for its second night, not 125", async () => {
      await service.postRoomChargeForDate(
        tx as never,
        reservation({
          confirmedRate: new Prisma.Decimal('250'),
          checkInDate: new Date('2026-09-01T00:00:00.000Z'),
          checkOutDate: new Date('2026-09-03T00:00:00.000Z'),
          nightlyRates: [
            { date: '2026-09-01', rate: '100.00' },
            { date: '2026-09-02', rate: '150.00' },
          ],
        }) as never,
        folio() as never,
        new Date('2026-09-02T00:00:00.000Z'),
        'Night Audit',
        ACTOR_ID,
      );
      expect(tx.lineItem.create.mock.calls[0][0].data.amount.toFixed(2)).toBe('150.00');
    });

    it('derives one night from the stay total (confirmedRate / nights), not the room type base rate', async () => {
      await service.postRoomChargeForDate(tx as never, reservation() as never, folio() as never, new Date('2026-09-01T00:00:00.000Z'), 'Check-in', ACTOR_ID);
      expect(tx.lineItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ chargeType: 'room', amount: expect.objectContaining({ toFixed: expect.any(Function) }) }),
        }),
      );
      const created = tx.lineItem.create.mock.calls[0][0].data;
      expect(created.amount.toFixed(2)).toBe('100.00'); // 300 / 3 nights
    });

    it('prefers an absolute nightly overrideRate over the derived figure, so a discount applies every night', async () => {
      await service.postRoomChargeForDate(
        tx as never,
        reservation({ overrideRate: new Prisma.Decimal('80') }) as never,
        folio() as never,
        new Date('2026-09-01T00:00:00.000Z'),
        'Check-in',
        ACTOR_ID,
      );
      expect(tx.lineItem.create.mock.calls[0][0].data.amount.toFixed(2)).toBe('80.00');
    });

    it('REFUSES to double-post a night already billed — the guard that makes night audit safe to add', async () => {
      tx.lineItem.findFirst.mockResolvedValue({ id: 'existing-room-charge' });
      const result = await service.postRoomChargeForDate(tx as never, reservation() as never, folio() as never, new Date('2026-09-01T00:00:00.000Z'), 'Night Audit', ACTOR_ID);
      expect(result).toBeNull();
      expect(tx.lineItem.create).not.toHaveBeenCalled();
    });

    it('looks for the night by its stay, wherever it sits now — a night moved to another bill is not billed again', async () => {
      await service.postRoomChargeForDate(tx as never, reservation() as never, folio() as never, new Date('2026-09-02T00:00:00.000Z'), 'Check-out', ACTOR_ID);
      expect(tx.lineItem.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          chargeType: 'room',
          OR: [{ stayReservationId: RESERVATION_ID }, { stayReservationId: null, folioId: FOLIO_ID }],
        }),
      });
    });

    it("bills the night to the group's master bill when the stay is routed to one", async () => {
      tx.folio.findFirst.mockResolvedValueOnce(folio({ id: 'master', status: 'open' }));
      await service.postRoomChargeForDate(tx as never, reservation({ billToFolioId: 'master' }) as never, folio() as never, new Date('2026-09-02T00:00:00.000Z'), 'Night Audit', ACTOR_ID);
      expect(tx.lineItem.create.mock.calls[0][0].data.folioId).toBe('master');
    });

    it('once the master bill is settled, nights go back on the guest’s own bill', async () => {
      tx.folio.findFirst.mockResolvedValueOnce(folio({ id: 'master', status: 'settled' }));
      await service.postRoomChargeForDate(tx as never, reservation({ billToFolioId: 'master' }) as never, folio() as never, new Date('2026-09-02T00:00:00.000Z'), 'Night Audit', ACTOR_ID);
      expect(tx.lineItem.create.mock.calls[0][0].data.folioId).toBe(FOLIO_ID);
    });

    it('records the stay on the night it posts', async () => {
      await service.postRoomChargeForDate(tx as never, reservation() as never, folio() as never, new Date('2026-09-02T00:00:00.000Z'), 'Night Audit', ACTOR_ID);
      expect(tx.lineItem.create.mock.calls[0][0].data.stayReservationId).toBe(RESERVATION_ID);
    });

    it('tags the description with its source so a system post is distinguishable from a hand post', async () => {
      await service.postRoomChargeForDate(tx as never, reservation() as never, folio() as never, new Date('2026-09-02T00:00:00.000Z'), 'Night Audit', ACTOR_ID);
      expect(tx.lineItem.create.mock.calls[0][0].data.description).toBe('Room Charge — Night Audit, 2026-09-02 (Deluxe Room)');
    });
  });

  describe('backfillRoomCharges — the check-out safety net', () => {
    it('posts every elapsed night, stopping before the departure day', async () => {
      // Stay 01→04 (3 nights), "today" is the 04th: nights 01, 02, 03 bill.
      const posted = await service.backfillRoomCharges(
        tx as never,
        reservation() as never,
        folio() as never,
        new Date('2026-09-04T00:00:00.000Z'),
        'Check-out',
        ACTOR_ID,
      );
      expect(posted).toBe(3);
      const dates = tx.lineItem.create.mock.calls.map((c) => c[0].data.serviceDate.toISOString().slice(0, 10));
      expect(dates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    });

    it('never bills nights that have not happened yet (early departure)', async () => {
      // Same stay, but the guest leaves on the 02nd — only the 01st is billable.
      const posted = await service.backfillRoomCharges(
        tx as never,
        reservation() as never,
        folio() as never,
        new Date('2026-09-02T00:00:00.000Z'),
        'Check-out',
        ACTOR_ID,
      );
      expect(posted).toBe(1);
    });

    it('skips nights already billed, so it is safe to run repeatedly', async () => {
      tx.lineItem.findFirst.mockResolvedValue({ id: 'already-billed' });
      const posted = await service.backfillRoomCharges(
        tx as never,
        reservation() as never,
        folio() as never,
        new Date('2026-09-04T00:00:00.000Z'),
        'Check-out',
        ACTOR_ID,
      );
      expect(posted).toBe(0);
      expect(tx.lineItem.create).not.toHaveBeenCalled();
    });
  });

  describe('postCharge — taxes as separate line items', () => {
    it('writes the parent charge plus one tax line item per matching rule', async () => {
      tx.folio.findFirst.mockResolvedValue(folio());
      taxesService.priceCharge.mockResolvedValue(
        priced('10000', [
          { ruleId: 'vat', ruleName: 'VAT', rate: new Prisma.Decimal('0.075'), taxAmount: new Prisma.Decimal('750') },
          { ruleId: 'svc', ruleName: 'Service Charge', rate: new Prisma.Decimal('0.1'), taxAmount: new Prisma.Decimal('1000') },
        ]),
      );
      await service.postCharge(TENANT_ID, FOLIO_ID, { description: 'Dinner', amount: 10000, chargeType: 'fnb' }, ACTOR_ID);

      expect(tx.lineItem.create).toHaveBeenCalledTimes(3); // parent + 2 tax rows
      const parent = tx.lineItem.create.mock.calls[0][0].data;
      expect(parent.chargeType).toBe('fnb');
      // taxAmount on the parent is display-only; the ledger entries are the tax rows
      expect(parent.taxAmount.toFixed(2)).toBe('1750.00');
      const taxRows = tx.lineItem.create.mock.calls.slice(1).map((c) => c[0].data);
      expect(taxRows.every((r) => r.chargeType === 'tax')).toBe(true);
      expect(taxRows.map((r) => r.taxRuleIds)).toEqual([['vat'], ['svc']]);
    });

    it('posts the net when the branch includes its tax in its prices — the charge and its tax make the price', async () => {
      tx.folio.findFirst.mockResolvedValue(folio());
      taxesService.priceCharge.mockResolvedValue(
        priced('10750', [{ ruleId: 'vat', ruleName: 'VAT', rate: new Prisma.Decimal('0.075'), taxAmount: new Prisma.Decimal('750'), inclusive: true }]),
      );
      await service.postCharge(TENANT_ID, FOLIO_ID, { description: 'Dinner', amount: 10750, chargeType: 'fnb' }, ACTOR_ID);

      const [parent, vat] = tx.lineItem.create.mock.calls.map((c) => (c as [{ data: { amount: Prisma.Decimal; description: string } }])[0].data);
      expect(parent.amount.toFixed(2)).toBe('10000.00');
      expect(vat.amount.toFixed(2)).toBe('750.00');
      expect(vat.description).toBe('VAT (7.5%, included) — Dinner');
      expect(tx.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ after: expect.objectContaining({ price: '10750.00', taxIncluded: '750.00' }) }) }),
      );
    });

    it('rejects posting to a settled folio', async () => {
      tx.folio.findFirst.mockResolvedValue(folio({ status: 'settled' }));
      await expect(
        service.postCharge(TENANT_ID, FOLIO_ID, { description: 'Dinner', amount: 100, chargeType: 'fnb' }, ACTOR_ID),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('recordPayment — shift attribution', () => {
    beforeEach(() => tx.folio.findFirst.mockResolvedValue(folio()));

    it('attaches the agent\'s open shift to a cash payment', async () => {
      tx.shift.findFirst.mockResolvedValue({ id: 'shift-1' });
      await service.recordPayment(TENANT_ID, FOLIO_ID, { amount: 5000, method: 'cash' } as never, ACTOR_ID);
      expect(tx.shift.findFirst).toHaveBeenCalledWith({ where: { branchId: BRANCH_ID, agentId: ACTOR_ID, closedAt: null } });
      expect(tx.payment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ shiftId: 'shift-1' }) }));
    });

    it('tells any webhook listening for payments', async () => {
      tx.payment.create.mockResolvedValueOnce({ id: 'pay-9' });
      await service.recordPayment(TENANT_ID, FOLIO_ID, { amount: 5000, method: 'card' } as never, ACTOR_ID);
      expect(webhookEvents.paymentRecorded).toHaveBeenCalledWith(tx, { tenantId: TENANT_ID, branchId: BRANCH_ID, type: 'payment.received', paymentId: 'pay-9' });
    });

    it('refuses cash when the agent has no open shift — it would never be counted', async () => {
      tx.shift.findFirst.mockResolvedValue(null);
      await expect(service.recordPayment(TENANT_ID, FOLIO_ID, { amount: 5000, method: 'cash' } as never, ACTOR_ID)).rejects.toThrow(/Open a shift/);
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('never looks up a shift for a non-cash payment', async () => {
      await service.recordPayment(TENANT_ID, FOLIO_ID, { amount: 5000, method: 'card' } as never, ACTOR_ID);
      expect(tx.shift.findFirst).not.toHaveBeenCalled();
      expect(tx.payment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ shiftId: undefined }) }));
    });

    it("refuses a plain loyalty-points payment — points come off a balance only through a redemption", async () => {
      await expect(service.recordPayment(TENANT_ID, FOLIO_ID, { amount: 5000, method: 'loyalty_points' } as never, ACTOR_ID)).rejects.toThrow(/Redeem Points/);
      expect(tx.payment.create).not.toHaveBeenCalled();
    });
  });

  describe('balance — computed, never stored', () => {
    beforeEach(() => tx.folio.findFirst.mockResolvedValue(folio()));

    it('balance = charges (incl. tax rows) minus payments', async () => {
      tx.lineItem.findMany.mockResolvedValue([
        { amount: new Prisma.Decimal('10000'), chargeType: 'fnb' },
        { amount: new Prisma.Decimal('750'), chargeType: 'tax' },
      ]);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('2000'), paymentPurpose: 'payment' }]);
      const result = await service.getFolio(TENANT_ID, FOLIO_ID);
      expect(result.totals.subTotal.toFixed(2)).toBe('10000.00');
      expect(result.totals.taxTotal.toFixed(2)).toBe('750.00');
      expect(result.totals.totalCost.toFixed(2)).toBe('10750.00');
      expect(result.totals.balanceDue.toFixed(2)).toBe('8750.00');
    });

    it('excludes voided and soft-deleted rows from the ledger query', async () => {
      await service.getFolio(TENANT_ID, FOLIO_ID);
      expect(tx.lineItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isVoid: false, deletedAt: null }) }),
      );
    });

    it('counts a deposit as a payment but never as a line item', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('500'), chargeType: 'room' }]);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('200'), paymentPurpose: 'deposit' }]);
      const result = await service.getFolio(TENANT_ID, FOLIO_ID);
      expect(result.totals.depositsTotal.toFixed(2)).toBe('200.00');
      expect(result.totals.subTotal.toFixed(2)).toBe('500.00');
      expect(result.totals.balanceDue.toFixed(2)).toBe('300.00');
    });

    it('a negative balance is a credit owed back to the guest', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('150'), paymentPurpose: 'payment' }]);
      const result = await service.getFolio(TENANT_ID, FOLIO_ID);
      expect(result.totals.balanceDue.toFixed(2)).toBe('-50.00');
    });
  });

  describe('correctLineItem — append-only', () => {
    const original = (over: Record<string, unknown> = {}) => ({
      id: 'li-original', folioId: FOLIO_ID, description: 'Minibar', chargeType: 'minibar', taxRuleIds: [],
      amount: new Prisma.Decimal('5000'), serviceDate: new Date('2026-09-01'), ...over,
    });
    const taxLine = (over: Record<string, unknown> = {}) => ({
      id: 'li-vat', folioId: FOLIO_ID, description: 'VAT (7.5%) — Minibar', chargeType: 'tax', taxRuleIds: ['rule-vat'],
      amount: new Prisma.Decimal('375'), serviceDate: new Date('2026-09-01'), correctedBy: null, ...over,
    });

    beforeEach(() => {
      tx.folio.findFirst.mockResolvedValue(folio());
      // 1st findFirst: the line being corrected. 2nd: "already corrected?" — no.
      tx.lineItem.findFirst.mockResolvedValueOnce(original()).mockResolvedValueOnce(null);
    });

    it('appends a negating correction and never mutates the original', async () => {
      await service.correctLineItem(TENANT_ID, 'li-original', { reason: 'Guest disputed' }, ACTOR_ID);
      const created = tx.lineItem.create.mock.calls[0][0].data;
      expect(created.amount.toFixed(2)).toBe('-5000.00');
      expect(created.chargeType).toBe('correction');
      expect(created.correctsLineItemId).toBe('li-original');
      expect(created.description).toContain('Guest disputed');
      // The original row must be untouched — no update call anywhere.
      expect(tx.lineItem).not.toHaveProperty('update');
    });

    it("reverses the charge's own tax lines with it — VAT on a corrected charge no longer survives", async () => {
      tx.lineItem.findMany.mockResolvedValue([taxLine()]);
      await service.correctLineItem(TENANT_ID, 'li-original', { reason: 'Returned unopened' }, ACTOR_ID);
      expect(tx.lineItem.create).toHaveBeenCalledTimes(2);
      const reversal = tx.lineItem.create.mock.calls[1][0].data;
      expect(reversal.amount.toFixed(2)).toBe('-375.00');
      expect(reversal.chargeType).toBe('tax'); // stays tax, so tax totals and the breakdown net down
      expect(reversal.taxRuleIds).toEqual(['rule-vat']);
      expect(reversal.correctsLineItemId).toBe('li-vat');
      expect(reversal.parentLineItemId).toBe('li-1'); // the new correction row
      expect(tx.lineItem.create.mock.calls[0][0].data.taxAmount.toFixed(2)).toBe('-375.00');
    });

    it('only looks for tax lines linked to this charge, on this folio', async () => {
      await service.correctLineItem(TENANT_ID, 'li-original', { reason: 'x' }, ACTOR_ID);
      expect(tx.lineItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { parentLineItemId: 'li-original', folioId: FOLIO_ID, chargeType: 'tax', isVoid: false, deletedAt: null } }),
      );
    });

    it('skips a tax line that staff already corrected on its own', async () => {
      tx.lineItem.findMany.mockResolvedValue([taxLine({ correctedBy: { id: 'earlier-fix' } })]);
      await service.correctLineItem(TENANT_ID, 'li-original', { reason: 'x' }, ACTOR_ID);
      expect(tx.lineItem.create).toHaveBeenCalledTimes(1);
    });

    it('refuses to correct a line twice — the charge and its tax would reverse again', async () => {
      tx.lineItem.findFirst.mockReset();
      tx.lineItem.findFirst.mockResolvedValueOnce(original()).mockResolvedValueOnce({ id: 'earlier-correction' });
      await expect(service.correctLineItem(TENANT_ID, 'li-original', { reason: 'x' }, ACTOR_ID)).rejects.toThrow(ConflictException);
      expect(tx.lineItem.create).not.toHaveBeenCalled();
    });

    it('a tax line corrected on its own becomes a negating tax line for that rule, nothing else touched', async () => {
      tx.lineItem.findFirst.mockReset();
      tx.lineItem.findFirst.mockResolvedValueOnce(taxLine()).mockResolvedValueOnce(null);
      await service.correctLineItem(TENANT_ID, 'li-vat', { reason: 'Guest is tax-exempt' }, ACTOR_ID);
      expect(tx.lineItem.findMany).not.toHaveBeenCalled();
      expect(tx.lineItem.create).toHaveBeenCalledTimes(1);
      const created = tx.lineItem.create.mock.calls[0][0].data;
      expect(created.chargeType).toBe('tax');
      expect(created.taxRuleIds).toEqual(['rule-vat']);
      expect(created.amount.toFixed(2)).toBe('-375.00');
    });

    it('turns a concurrent double-correction (unique index) into the same 409', async () => {
      tx.lineItem.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }));
      await expect(service.correctLineItem(TENANT_ID, 'li-original', { reason: 'x' }, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('404s on a missing line item', async () => {
      tx.lineItem.findFirst.mockReset();
      tx.lineItem.findFirst.mockResolvedValue(null);
      await expect(service.correctLineItem(TENANT_ID, 'nope', { reason: 'x' }, ACTOR_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('splitFolio — moving charges between a reservation\'s folios', () => {
    const TARGET_ID = '88888888-8888-4888-8888-888888888888';
    const dto = { targetFolioId: TARGET_ID, lineItemIds: ['li-1', 'li-2'], reason: 'Room to company account' };

    beforeEach(() => {
      tx.folio.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === TARGET_ID ? folio({ id: TARGET_ID, label: 'Company' }) : folio()),
      );
      tx.lineItem.findMany.mockResolvedValue([
        { id: 'li-1', amount: new Prisma.Decimal('20000') },
        { id: 'li-2', amount: new Prisma.Decimal('1500') },
      ]);
    });

    it('reassigns the folio without touching any amount, and snapshots what moved', async () => {
      const transfer = await service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID);
      expect(tx.lineItem.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['li-1', 'li-2'] } },
        data: { folioId: TARGET_ID }, // folioId only — no amount in this update
      });
      expect(tx.folioTransfer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lineItemIds: ['li-1', 'li-2'], reason: dto.reason }),
        }),
      );
      expect(transfer).toBeDefined();
    });

    it('records the transfer amount as the sum of what moved (balance is conserved across the pair)', async () => {
      await service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID);
      expect(tx.folioTransfer.create.mock.calls[0][0].data.amount.toFixed(2)).toBe('21500.00');
    });

    it("moves a charge's linked tax lines with it even when only the charge was selected", async () => {
      tx.lineItem.findMany
        .mockResolvedValueOnce([
          { id: 'li-1', amount: new Prisma.Decimal('20000'), chargeType: 'room', parentLineItemId: null },
          { id: 'li-2', amount: new Prisma.Decimal('1500'), chargeType: 'minibar', parentLineItemId: null },
        ])
        .mockResolvedValueOnce([{ id: 'li-1-vat', amount: new Prisma.Decimal('1500'), chargeType: 'tax', parentLineItemId: 'li-1' }]);
      await service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID);
      expect(tx.lineItem.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['li-1', 'li-2', 'li-1-vat'] } }, data: { folioId: TARGET_ID } });
      const transferData = tx.folioTransfer.create.mock.calls[0][0].data;
      expect(transferData.lineItemIds).toEqual(['li-1', 'li-2', 'li-1-vat']);
      expect(transferData.amount.toFixed(2)).toBe('23000.00');
    });

    it('refuses to move a linked tax line away from its charge', async () => {
      tx.lineItem.findMany.mockResolvedValueOnce([
        { id: 'li-1', amount: new Prisma.Decimal('1500'), chargeType: 'tax', parentLineItemId: 'charge-staying-behind' },
        { id: 'li-2', amount: new Prisma.Decimal('500'), chargeType: 'minibar', parentLineItemId: null },
      ]);
      await expect(service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID)).rejects.toThrow(BadRequestException);
      expect(tx.lineItem.updateMany).not.toHaveBeenCalled();
    });

    it('rejects splitting a folio into itself', async () => {
      await expect(service.splitFolio(TENANT_ID, FOLIO_ID, { ...dto, targetFolioId: FOLIO_ID }, ACTOR_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a target folio on a different reservation — that is a transfer, not a split', async () => {
      tx.folio.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === TARGET_ID ? folio({ id: TARGET_ID, reservationId: 'other-reservation' }) : folio()),
      );
      await expect(service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID)).rejects.toThrow(BadRequestException);
      expect(tx.lineItem.updateMany).not.toHaveBeenCalled();
    });

    it('rejects line items that do not belong to the source folio', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ id: 'li-1', amount: new Prisma.Decimal('20000') }]); // only 1 of 2 found
      await expect(service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID)).rejects.toThrow(BadRequestException);
      expect(tx.lineItem.updateMany).not.toHaveBeenCalled();
    });

    it('rejects splitting out of a settled folio', async () => {
      tx.folio.findFirst.mockResolvedValue(folio({ status: 'settled' }));
      await expect(service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });
  });

  describe("transferCharges — onto another stay's bill", () => {
    const TARGET_ID = '88888888-8888-4888-8888-888888888888';
    const OTHER_STAY = '77777777-7777-4777-8777-777777777777';
    const dto = { targetFolioId: TARGET_ID, lineItemIds: ['li-1'], reason: 'Room 102 pays for room 101' };
    const charge = (overrides: Record<string, unknown> = {}) => ({
      id: 'li-1',
      folioId: FOLIO_ID,
      amount: new Prisma.Decimal('20000'),
      chargeType: 'room',
      parentLineItemId: null,
      correctsLineItemId: null,
      ...overrides,
    });

    beforeEach(() => {
      tx.folio.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === TARGET_ID ? folio({ id: TARGET_ID, reservationId: OTHER_STAY }) : folio()),
      );
      tx.lineItem.findMany.mockResolvedValue([]);
    });

    it("moves a charge onto another stay's bill, recording both stays", async () => {
      tx.lineItem.findMany.mockResolvedValueOnce([charge()]);
      await service.transferCharges(TENANT_ID, FOLIO_ID, dto, ACTOR_ID);
      expect(tx.lineItem.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['li-1'] } }, data: { folioId: TARGET_ID } });
      const entry = tx.auditLog.create.mock.calls[0][0].data;
      expect(entry.action).toBe('folio.transferred');
      expect(entry.after).toMatchObject({ fromReservationId: RESERVATION_ID, toReservationId: OTHER_STAY, amount: '20000.00' });
    });

    it('a split still refuses another stay — that move is a transfer', async () => {
      await expect(service.splitFolio(TENANT_ID, FOLIO_ID, dto, ACTOR_ID)).rejects.toThrow(/Folio Transfer/);
    });

    it('never moves charges to a bill at another property', async () => {
      tx.folio.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === TARGET_ID ? folio({ id: TARGET_ID, reservationId: OTHER_STAY, branchId: 'other-branch' }) : folio()),
      );
      await expect(service.transferCharges(TENANT_ID, FOLIO_ID, dto, ACTOR_ID)).rejects.toThrow(/same property/);
      expect(tx.lineItem.updateMany).not.toHaveBeenCalled();
    });

    it('moving everything takes every charge on the bill, with what hangs off each', async () => {
      tx.lineItem.findMany.mockResolvedValueOnce([charge(), charge({ id: 'li-2', chargeType: 'minibar', amount: new Prisma.Decimal('3000') })]);
      tx.lineItem.findMany.mockResolvedValueOnce([charge({ id: 'li-1-vat', chargeType: 'tax', parentLineItemId: 'li-1', amount: new Prisma.Decimal('1500') })]);
      await service.transferCharges(TENANT_ID, FOLIO_ID, { targetFolioId: TARGET_ID, transferAll: true, reason: dto.reason }, ACTOR_ID);
      expect(tx.lineItem.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['li-1', 'li-2', 'li-1-vat'] } }, data: { folioId: TARGET_ID } });
      expect(tx.folioTransfer.create.mock.calls[0][0].data.amount.toFixed(2)).toBe('24500.00');
    });

    it('moving everything off an empty bill is refused', async () => {
      await expect(service.transferCharges(TENANT_ID, FOLIO_ID, { targetFolioId: TARGET_ID, transferAll: true, reason: 'x' }, ACTOR_ID)).rejects.toThrow(/no charges/);
    });

    it("a corrected charge takes its correction and the correction's tax reversal with it", async () => {
      tx.lineItem.findMany
        .mockResolvedValueOnce([charge({ chargeType: 'minibar' })])
        .mockResolvedValueOnce([
          charge({ id: 'vat', chargeType: 'tax', parentLineItemId: 'li-1', amount: new Prisma.Decimal('1500') }),
          charge({ id: 'fix', chargeType: 'correction', correctsLineItemId: 'li-1', amount: new Prisma.Decimal('-20000') }),
        ])
        .mockResolvedValueOnce([charge({ id: 'fix-vat', chargeType: 'tax', parentLineItemId: 'fix', correctsLineItemId: 'vat', amount: new Prisma.Decimal('-1500') })]);
      await service.transferCharges(TENANT_ID, FOLIO_ID, dto, ACTOR_ID);
      expect(tx.lineItem.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['li-1', 'vat', 'fix', 'fix-vat'] } }, data: { folioId: TARGET_ID } });
      expect(tx.folioTransfer.create.mock.calls[0][0].data.amount.toFixed(2)).toBe('0.00');
    });

    it('a correction picked without its charge is refused', async () => {
      tx.lineItem.findMany.mockResolvedValueOnce([charge({ id: 'fix', chargeType: 'correction', correctsLineItemId: 'charge-staying' })]);
      await expect(service.transferCharges(TENANT_ID, FOLIO_ID, { ...dto, lineItemIds: ['fix'] }, ACTOR_ID)).rejects.toThrow(/select the charge instead/);
    });

    it('a Point of Sale order follows its room charge to the new bill', async () => {
      tx.lineItem.findMany.mockResolvedValueOnce([charge({ chargeType: 'fnb' })]);
      await service.transferCharges(TENANT_ID, FOLIO_ID, dto, ACTOR_ID);
      expect(tx.posOrder.updateMany).toHaveBeenCalledWith({ where: { lineItemId: { in: ['li-1'] } }, data: { folioId: TARGET_ID } });
    });
  });

  describe('reverseTransfer — the 24-hour undo', () => {
    const TARGET_ID = '88888888-8888-4888-8888-888888888888';
    const transfer = (overrides: Record<string, unknown> = {}) => ({
      id: 'transfer-1',
      sourceFolioId: FOLIO_ID,
      targetFolioId: TARGET_ID,
      lineItemIds: ['li-1', 'li-1-vat'],
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      reversedAt: null,
      ...overrides,
    });

    beforeEach(() => {
      tx.folio.findFirst.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(folio({ id: where.id })));
      tx.lineItem.findMany.mockResolvedValue([]);
    });

    it('puts the charges back where they came from and marks the transfer reversed', async () => {
      tx.folioTransfer.findFirst.mockResolvedValue(transfer());
      tx.lineItem.findMany.mockResolvedValueOnce([
        { id: 'li-1', folioId: TARGET_ID, amount: new Prisma.Decimal('20000'), chargeType: 'room', parentLineItemId: null, correctsLineItemId: null },
        { id: 'li-1-vat', folioId: TARGET_ID, amount: new Prisma.Decimal('1500'), chargeType: 'tax', parentLineItemId: 'li-1', correctsLineItemId: null },
      ]);
      await service.reverseTransfer(TENANT_ID, 'transfer-1', ACTOR_ID);
      expect(tx.lineItem.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['li-1', 'li-1-vat'] } }, data: { folioId: FOLIO_ID } });
      expect(tx.folioTransfer.update).toHaveBeenCalledWith({ where: { id: 'transfer-1' }, data: { reversedAt: expect.any(Date), reversedBy: ACTOR_ID } });
    });

    it('after a day it has to be a new transfer', async () => {
      tx.folioTransfer.findFirst.mockResolvedValue(transfer({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }));
      await expect(service.reverseTransfer(TENANT_ID, 'transfer-1', ACTOR_ID)).rejects.toThrow(/24 hours/);
    });

    it('refuses once a charge has moved on again', async () => {
      tx.folioTransfer.findFirst.mockResolvedValue(transfer());
      tx.lineItem.findMany.mockResolvedValueOnce([{ id: 'li-1', folioId: 'somewhere-else' }]);
      await expect(service.reverseTransfer(TENANT_ID, 'transfer-1', ACTOR_ID)).rejects.toThrow(/moved to another bill since/);
      expect(tx.lineItem.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a second reversal', async () => {
      tx.folioTransfer.findFirst.mockResolvedValue(transfer({ reversedAt: new Date() }));
      await expect(service.reverseTransfer(TENANT_ID, 'transfer-1', ACTOR_ID)).rejects.toThrow(/already been reversed/);
    });
  });

  describe('createAdditionalFolio', () => {
    beforeEach(() => tx.reservation.findFirst.mockResolvedValue(reservation()));

    it('names who pays it and the company it goes to', async () => {
      tx.corporateAccount.findFirst.mockResolvedValue({ id: 'acct-1' });
      await service.createAdditionalFolio(TENANT_ID, RESERVATION_ID, { label: ' Company ', payerName: 'Dangote travel desk', corporateAccountId: 'acct-1' }, ACTOR_ID);
      expect(tx.folio.create.mock.calls[0][0].data).toMatchObject({ label: 'Company', payerName: 'Dangote travel desk', corporateAccountId: 'acct-1', status: 'open' });
    });

    it("refuses a company that isn't active", async () => {
      await expect(service.createAdditionalFolio(TENANT_ID, RESERVATION_ID, { label: 'Company', corporateAccountId: 'acct-1' }, ACTOR_ID)).rejects.toThrow(BadRequestException);
      expect(tx.folio.create).not.toHaveBeenCalled();
    });
  });

  describe('closeFolio — the only FOLIO_NOT_SETTLED path', () => {
    beforeEach(() => tx.folio.findFirst.mockResolvedValue(folio()));

    it('rejects closing a folio that still owes', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      await expect(service.closeFolio(TENANT_ID, FOLIO_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('settles at a zero balance', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), paymentPurpose: 'payment' }]);
      await service.closeFolio(TENANT_ID, FOLIO_ID, ACTOR_ID);
      expect(tx.folio.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'settled' }) }),
      );
    });

    it('settles at a credit balance too', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('150'), paymentPurpose: 'payment' }]);
      await expect(service.closeFolio(TENANT_ID, FOLIO_ID, ACTOR_ID)).resolves.toBeDefined();
    });
  });

  describe('settleIfFullyPaid — shared by check-out and no-show, which must never throw', () => {
    it('leaves the folio OPEN when a balance is outstanding, instead of throwing (City Ledger)', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      const settled = await service.settleIfFullyPaid(tx as never, folio() as never, ACTOR_ID, 'checkOut');
      expect(settled).toBe(false);
      expect(tx.folio.update).not.toHaveBeenCalled();
    });

    it('settles when fully paid', async () => {
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), paymentPurpose: 'payment' }]);
      const settled = await service.settleIfFullyPaid(tx as never, folio() as never, ACTOR_ID, 'checkOut');
      expect(settled).toBe(true);
    });

    it('records which caller closed it, not a hardcoded "via checkout" — a no-show settling at zero balance must not lie about how it closed', async () => {
      tx.lineItem.findMany.mockResolvedValue([]);
      await service.settleIfFullyPaid(tx as never, folio() as never, ACTOR_ID, 'noShow');
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ after: expect.objectContaining({ via: 'noShow' }) }) }));
    });
  });

  describe('postAdHocCharge', () => {
    const adHocReservation = { tenantId: TENANT_ID, branchId: BRANCH_ID, checkInDate: new Date('2026-09-01') };

    it('posts a positive amount as the given chargeType, taxed like any other charge', async () => {
      taxesService.priceCharge.mockResolvedValue(priced('50', [{ ruleId: 'vat', ruleName: 'VAT', rate: new Prisma.Decimal('0.1'), taxAmount: new Prisma.Decimal('5') }]));
      const result = await service.postAdHocCharge(tx as never, adHocReservation as never, folio() as never, 'penalty', new Prisma.Decimal('50'), 'No-show penalty', ACTOR_ID);
      expect(result).not.toBeNull();
      expect(tx.lineItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: expect.objectContaining({ toString: expect.any(Function) }), chargeType: 'penalty' }) }));
    });

    it('links every tax line to the charge it was computed on', async () => {
      taxesService.priceCharge.mockResolvedValue(
        priced('50', [
          { ruleId: 'vat', ruleName: 'VAT', rate: new Prisma.Decimal('0.075'), taxAmount: new Prisma.Decimal('3.75') },
          { ruleId: 'levy', ruleName: 'Levy', rate: new Prisma.Decimal('0.05'), taxAmount: new Prisma.Decimal('2.50') },
        ]),
      );
      await service.postAdHocCharge(tx as never, adHocReservation as never, folio() as never, 'penalty', new Prisma.Decimal('50'), 'No-show penalty', ACTOR_ID);
      const [parentData, ...taxData] = tx.lineItem.create.mock.calls.map((call) => (call as [{ data: Record<string, unknown> }])[0].data);
      expect(parentData.parentLineItemId).toBeUndefined();
      expect(taxData).toHaveLength(2);
      taxData.forEach((data) => expect(data.parentLineItemId).toBe('li-1'));
    });

    it('refuses a negative amount — a credit reverses a specific charge, through reverseChargeInTx', async () => {
      await expect(
        service.postAdHocCharge(tx as never, adHocReservation as never, folio() as never, 'correction', new Prisma.Decimal('-50'), 'Penalty waived', ACTOR_ID),
      ).rejects.toThrow(/reversal/);
      expect(tx.lineItem.create).not.toHaveBeenCalled();
    });
  });

  describe('reverseChargeInTx', () => {
    const penalty = { id: 'li-penalty', folioId: FOLIO_ID, description: 'No-Show Penalty (first night)', amount: new Prisma.Decimal('30000'), chargeType: 'penalty', taxRuleIds: [], serviceDate: null, outletId: null };
    const penaltyVat = { id: 'li-vat', folioId: FOLIO_ID, description: 'VAT (7.5%) — No-Show Penalty (first night)', amount: new Prisma.Decimal('2250'), chargeType: 'tax', taxRuleIds: ['vat'], serviceDate: null, outletId: null, correctedBy: null };

    it('takes back the charge and exactly the tax posted with it — on a settled bill too', async () => {
      tx.lineItem.findFirst.mockResolvedValueOnce(penalty).mockResolvedValue(null);
      tx.lineItem.findMany.mockResolvedValue([penaltyVat]);
      tx.folio.findFirst.mockResolvedValue(folio({ status: 'settled' }));

      const reversal = await service.reverseChargeInTx(tx as never, TENANT_ID, 'li-penalty', 'penalty waived', ACTOR_ID);

      expect(reversal).not.toBeNull();
      const [charge, tax] = tx.lineItem.create.mock.calls.map((c) => (c as [{ data: Record<string, unknown> }])[0].data);
      expect(charge).toMatchObject({ chargeType: 'correction', correctsLineItemId: 'li-penalty' });
      expect((charge.amount as Prisma.Decimal).toFixed(2)).toBe('-30000.00');
      expect(tax).toMatchObject({ chargeType: 'tax', correctsLineItemId: 'li-vat', taxRuleIds: ['vat'] });
      expect((tax.amount as Prisma.Decimal).toFixed(2)).toBe('-2250.00');
      // the tax rules aren't consulted: today's rates have nothing to do with what was charged
      expect(taxesService.priceCharge).not.toHaveBeenCalled();
    });

    it('does nothing when the charge was already taken back', async () => {
      tx.lineItem.findFirst.mockResolvedValueOnce(penalty).mockResolvedValueOnce({ id: 'already' });
      expect(await service.reverseChargeInTx(tx as never, TENANT_ID, 'li-penalty', 'penalty waived', ACTOR_ID)).toBeNull();
      expect(tx.lineItem.create).not.toHaveBeenCalled();
    });
  });

  /**
   * Found live: a real no-show penalty left `guestStatus: null` in the
   * folio list despite a positive balance — `deriveGuestStatus` only knew
   * about `checked_out`/`checked_in`, not `no_show`. A no-show who owes a
   * penalty is a City Ledger receivable too, arguably more so than a
   * checked-out guest (no ongoing in-house relationship left at all).
   */
  describe('listFolios — deriveGuestStatus', () => {
    function folioRow(overrides: Partial<Record<string, unknown>> = {}) {
      return { id: FOLIO_ID, status: 'open', openedAt: new Date(), closedAt: null, guest: { id: 'g-1', name: 'Guest' }, reservation: { id: RESERVATION_ID, status: 'confirmed', checkOutDate: new Date('2026-09-04') }, ...overrides };
    }

    it('checked_out with a balance owed is city_ledger', async () => {
      tx.folio.findMany.mockResolvedValue([folioRow({ reservation: { id: RESERVATION_ID, status: 'checked_out', checkOutDate: new Date('2026-09-04') } })]);
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      const [row] = await service.listFolios(TENANT_ID, BRANCH_ID, 'all');
      expect(row.guestStatus).toBe('city_ledger');
    });

    it('checked_in with a balance owed is in_house, not city_ledger', async () => {
      tx.folio.findMany.mockResolvedValue([folioRow({ reservation: { id: RESERVATION_ID, status: 'checked_in', checkOutDate: new Date('2026-09-04') } })]);
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      const [row] = await service.listFolios(TENANT_ID, BRANCH_ID, 'all');
      expect(row.guestStatus).toBe('in_house');
    });

    it('no_show with an unpaid penalty is ALSO city_ledger — the fix', async () => {
      tx.folio.findMany.mockResolvedValue([folioRow({ reservation: { id: RESERVATION_ID, status: 'no_show', checkOutDate: new Date('2026-09-04') } })]);
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('90'), chargeType: 'penalty' }]);
      const [row] = await service.listFolios(TENANT_ID, BRANCH_ID, 'all');
      expect(row.guestStatus).toBe('city_ledger');
    });

    it('a zero balance is never a guest-status concern, regardless of reservation status', async () => {
      tx.folio.findMany.mockResolvedValue([folioRow({ reservation: { id: RESERVATION_ID, status: 'no_show', checkOutDate: new Date('2026-09-04') } })]);
      tx.lineItem.findMany.mockResolvedValue([]);
      const [row] = await service.listFolios(TENANT_ID, BRANCH_ID, 'all');
      expect(row.guestStatus).toBeNull();
    });

    it("carries each folio's label, so a split folio isn't listed under the same name as the guest's primary folio", async () => {
      tx.folio.findMany.mockResolvedValue([folioRow({ id: 'f-primary', label: null }), folioRow({ id: 'f-company', label: 'Company' })]);
      tx.lineItem.findMany.mockResolvedValue([]);
      const rows = await service.listFolios(TENANT_ID, BRANCH_ID, 'all');
      expect(rows.map((r) => r.label)).toEqual([null, 'Company']);
    });

    it('an unpaid cancellation charge is a City Ledger receivable too', async () => {
      tx.folio.findMany.mockResolvedValue([folioRow({ reservation: { id: RESERVATION_ID, status: 'cancelled', checkOutDate: new Date('2026-09-04') } })]);
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('32250'), chargeType: 'penalty' }]);
      const [row] = await service.listFolios(TENANT_ID, BRANCH_ID, 'all');
      expect(row.guestStatus).toBe('city_ledger');
    });

    describe('quoting helpers used by cancellation', () => {
      it('previewCharge prices a charge under the tax rules without writing anything', async () => {
        taxesService.priceCharge.mockResolvedValue(
          priced('30000', [
            { ruleId: 'vat', ruleName: 'VAT', rate: new Prisma.Decimal('0.075'), taxAmount: new Prisma.Decimal('2250') },
            { ruleId: 'svc', ruleName: 'Service', rate: new Prisma.Decimal('0.05'), taxAmount: new Prisma.Decimal('1500') },
          ]),
        );
        const preview = await service.previewCharge(tx as never, BRANCH_ID, 'penalty', new Prisma.Decimal('30000'));
        expect(preview.addedTax.toFixed(2)).toBe('3750.00');
        expect(preview.total.toFixed(2)).toBe('33750.00');
        expect(tx.lineItem.create).not.toHaveBeenCalled();
      });

      it('paidOnPrimaryFolio is zero when no folio exists — and never creates one', async () => {
        tx.folio.findFirst.mockResolvedValue(null);
        const paid = await service.paidOnPrimaryFolio(tx as never, RESERVATION_ID);
        expect(paid.toFixed(2)).toBe('0.00');
        expect(tx.folio.create).not.toHaveBeenCalled();
      });

      it('paidOnPrimaryFolio sums payments on the primary folio', async () => {
        tx.folio.findFirst.mockResolvedValue({ id: FOLIO_ID });
        tx.payment.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('20000'), paymentPurpose: 'deposit' }]);
        const paid = await service.paidOnPrimaryFolio(tx as never, RESERVATION_ID);
        expect(paid.toFixed(2)).toBe('20000.00');
      });
    });

    /**
     * Found live, once the Alerts module started aggregating across both:
     * a guest who's STILL checked in past their own checkout date owes a
     * balance too, but this filter's own doc comment names it a "City
     * Ledger receivable" — that's a *departed* guest who still owes,
     * `PMS-OPERATIONS-GUIDE.md`'s own distinction. Before this fix, a
     * checked-in overdue-checkout guest showed up in BOTH `overdue` here
     * AND the new Alerts module's own "overdue checkout" category — one
     * real problem read as two.
     */
    it('overdue requires guestStatus city_ledger — a still-checked-in guest past checkout does NOT count, even with a past-due checkOutDate and a balance owed', async () => {
      const pastDate = new Date('2000-01-01');
      tx.folio.findMany.mockResolvedValue([folioRow({ reservation: { id: RESERVATION_ID, status: 'checked_in', checkOutDate: pastDate } })]);
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      const rows = await service.listFolios(TENANT_ID, BRANCH_ID, 'overdue');
      expect(rows).toHaveLength(0);
    });

    it('overdue includes a genuinely checked-out guest with a past checkOutDate and a balance owed', async () => {
      const pastDate = new Date('2000-01-01');
      tx.folio.findMany.mockResolvedValue([folioRow({ reservation: { id: RESERVATION_ID, status: 'checked_out', checkOutDate: pastDate } })]);
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      const rows = await service.listFolios(TENANT_ID, BRANCH_ID, 'overdue');
      expect(rows).toHaveLength(1);
    });

    it('overdue excludes a checked-out guest whose checkOutDate has NOT actually passed yet', async () => {
      const futureDate = new Date('2099-01-01');
      tx.folio.findMany.mockResolvedValue([folioRow({ reservation: { id: RESERVATION_ID, status: 'checked_out', checkOutDate: futureDate } })]);
      tx.lineItem.findMany.mockResolvedValue([{ amount: new Prisma.Decimal('100'), chargeType: 'room' }]);
      const rows = await service.listFolios(TENANT_ID, BRANCH_ID, 'overdue');
      expect(rows).toHaveLength(0);
    });
  });

  describe('getTaxBreakdown', () => {
    it('works out a fixed rule’s base from the charges it was added to, netting out a correction', async () => {
      tx.folio.findFirst.mockResolvedValue(folio());
      tx.taxRule.findMany.mockResolvedValue([
        { id: 'rule-city', name: 'City Tax', type: 'fixed', rate: new Prisma.Decimal(0), fixedAmount: new Prisma.Decimal('500'), inclusive: false },
        { id: 'rule-vat', name: 'VAT', type: 'percentage', rate: new Prisma.Decimal('0.075'), fixedAmount: null, inclusive: true },
      ]);
      tx.lineItem.findMany
        // the tax lines: two nights of city tax, one reversed by a correction; VAT on both nights
        .mockResolvedValueOnce([
          { amount: new Prisma.Decimal('500'), taxRuleIds: ['rule-city'], parentLineItemId: 'night-1' },
          { amount: new Prisma.Decimal('500'), taxRuleIds: ['rule-city'], parentLineItemId: 'night-2' },
          { amount: new Prisma.Decimal('-500'), taxRuleIds: ['rule-city'], parentLineItemId: 'correction-2' },
          { amount: new Prisma.Decimal('2250'), taxRuleIds: ['rule-vat'], parentLineItemId: 'night-1' },
        ])
        // their parent charges
        .mockResolvedValueOnce([
          { id: 'night-1', amount: new Prisma.Decimal('30000') },
          { id: 'night-2', amount: new Prisma.Decimal('30000') },
          { id: 'correction-2', amount: new Prisma.Decimal('-30000') },
        ]);

      const { rows, totalTax } = await service.getTaxBreakdown(TENANT_ID, FOLIO_ID);
      const city = rows.find((r) => r.ruleId === 'rule-city')!;
      const vat = rows.find((r) => r.ruleId === 'rule-vat')!;
      expect(city).toMatchObject({ type: 'fixed', inclusive: false });
      expect(vat).toMatchObject({ inclusive: true });
      expect(city.taxCollected.toFixed(2)).toBe('500.00');
      expect(city.taxableBase.toFixed(2)).toBe('30000.00');
      // percentage rules keep working back from what they collected
      expect(vat.taxableBase.toFixed(2)).toBe('30000.00');
      expect(totalTax.toFixed(2)).toBe('2750.00');
    });
  });
});
