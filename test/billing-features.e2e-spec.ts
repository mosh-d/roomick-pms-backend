import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, addDays, book, BranchLayout, checkIn, Client, deleteOrganisation, headBrand, hire, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * Deposits before arrival, voiding a payment, paying in another currency,
 * invoices, late check-out and early departure fees, accounts receivable
 * ageing, and billing an event to a guest's bill — against the real API and
 * database.
 */
describe('Billing features (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let desk: Session;
  let branch: BranchLayout;

  const bill = async (folioId: string) => (await client.get(`/folios/${folioId}`, owner)).body as {
    status: string;
    guestStatus: string | null;
    totals: { balanceDue: string; paymentsTotal: string; depositsTotal: string };
    lineItems: Array<{ description: string; amount: string; chargeType: string }>;
    payments: Array<{ id: string; amount: string; isVoid: boolean; foreignCurrency: string | null; foreignAmount: string | null; exchangeRate: string | null }>;
  };
  const primaryFolio = async (reservationId: string) => ((await client.get(`/reservations/${reservationId}/folios`, owner)).body as Array<{ id: string; label: string | null; status: string }>).find((f) => f.label === null);

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Billing');
    branch = await addBranch(client, owner, await headBrand(client, owner), 'Billing Branch', 8);
    desk = await hire(client, owner, branch.id, 'front_desk', 'billing-desk');
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  describe('deposits', () => {
    it('asks a new booking for the deposit the policy sets, holds it on a pending bill, and uses it at check-in', async () => {
      expect((await client.patch(`/branches/${branch.id}/policies/deposit`, owner, { type: 'percentage', value: 50, dueDaysBeforeArrival: 2 })).status).toBe(200);
      const arrival = lagosDay(5);
      const id = await book(client, owner, branch, 'Deposit Guest', arrival, lagosDay(7));
      const booked = (await client.get(`/reservations/${id}`, owner)).body as { depositAmount: string; depositDueDate: string; depositPaid: string };
      // Two nights at 20,000, no tax: half is 20,000, due two days before arrival.
      expect(Number(booked.depositAmount)).toBe(20_000);
      expect(booked.depositDueDate.slice(0, 10)).toBe(addDays(arrival, -2));
      expect(booked.depositPaid).toBe('0.00');

      const deposit = await client.post(`/reservations/${id}/deposits`, desk, { amount: 20_000, method: 'bank_transfer', reference: 'TRF-1' });
      expect(deposit.status).toBe(201);
      expect(deposit.body.paymentPurpose).toBe('deposit');
      const folio = await primaryFolio(id);
      expect(folio?.status).toBe('pending');
      const held = await bill(folio!.id);
      expect(held.guestStatus).toBe('deposit_held');
      expect(held.totals.depositsTotal).toBe('20000');
      expect((await client.get(`/reservations/${id}`, owner)).body.depositPaid).toBe('20000.00');
      // Held for a stay to come — not a refund owed.
      const refundsDue = (await client.get(`/branches/${branch.id}/folios?filter=refund_due`, owner)).body as Array<{ id: string }>;
      expect(refundsDue.map((f) => f.id)).not.toContain(folio!.id);
      // A pending bill has nothing to invoice yet.
      expect((await client.post(`/folios/${folio!.id}/invoices`, owner)).status).toBe(409);
    });

    it('opens the deposit’s bill at check-in, with the deposit set against the stay', async () => {
      const id = await book(client, owner, branch, 'Arriving With Deposit', lagosDay(0), lagosDay(2));
      expect((await client.post(`/reservations/${id}/deposits`, owner, { amount: 15_000, method: 'card' })).status).toBe(201);
      const folioId = await checkIn(client, owner, id, branch.rooms[0].id);
      const opened = await bill(folioId);
      expect(opened.status).toBe('open');
      // The arrival night (20,000) less the 15,000 deposit.
      expect(Number(opened.totals.balanceDue)).toBe(5_000);
      // Arrived: further money is a payment on the bill, not a deposit.
      expect((await client.post(`/reservations/${id}/deposits`, owner, { amount: 1_000, method: 'card' })).status).toBe(409);
    });

    it('a cancelled booking’s deposit becomes a refund owed', async () => {
      const id = await book(client, owner, branch, 'Cancels Early', lagosDay(10), lagosDay(11));
      expect((await client.post(`/reservations/${id}/deposits`, owner, { amount: 10_000, method: 'card' })).status).toBe(201);
      const cancelled = await client.post(`/reservations/${id}/cancel`, owner, { reason: 'Plans changed' });
      expect(cancelled.status).toBe(201);
      const folio = await primaryFolio(id);
      expect((await bill(folio!.id)).guestStatus).toBe('refund_due');
    });

    it('switching the policy off asks new bookings for nothing', async () => {
      expect((await client.patch(`/branches/${branch.id}/policies/deposit`, owner, { type: 'none', dueDaysBeforeArrival: 0 })).status).toBe(200);
      const id = await book(client, owner, branch, 'No Deposit', lagosDay(20), lagosDay(21));
      expect((await client.get(`/reservations/${id}`, owner)).body.depositAmount).toBeNull();
      // Only managers set it.
      expect((await client.patch(`/branches/${branch.id}/policies/deposit`, desk, { type: 'fixed', value: 5, dueDaysBeforeArrival: 0 })).status).toBe(403);
    });
  });

  describe('another currency', () => {
    let folioId: string;
    beforeAll(async () => {
      folioId = await checkIn(client, owner, await book(client, owner, branch, 'Dollar Guest', lagosDay(0), lagosDay(1)), branch.rooms[1].id);
    });

    it('takes payment in a currency with a rate set, turned into the branch’s own at that rate', async () => {
      expect((await client.put(`/branches/${branch.id}/exchange-rates/usd`, owner, { rate: 1500 })).status).toBe(200);
      expect((await client.put(`/branches/${branch.id}/exchange-rates/EUR`, desk, { rate: 1700 })).status).toBe(403);
      expect((await client.put(`/branches/${branch.id}/exchange-rates/NGN`, owner, { rate: 1 })).status).toBe(400);
      const rates = (await client.get(`/branches/${branch.id}/exchange-rates`, desk)).body as { baseCurrency: string; rates: Array<{ currency: string; rate: string }> };
      expect(rates.baseCurrency).toBe('NGN');
      expect(rates.rates).toEqual([expect.objectContaining({ currency: 'USD', rate: '1500' })]);

      const paid = await client.post(`/folios/${folioId}/payments`, desk, { amount: 10, method: 'card', currency: 'USD' });
      expect(paid.status).toBe(201);
      expect(Number(paid.body.amount)).toBe(15_000);
      expect(paid.body.currency).toBe('NGN');
      expect(paid.body.foreignCurrency).toBe('USD');
      expect(Number(paid.body.foreignAmount)).toBe(10);
      expect(Number(paid.body.exchangeRate)).toBe(1500);
      expect(Number((await bill(folioId)).totals.balanceDue)).toBe(5_000);
    });

    it('refuses a currency without a rate', async () => {
      const res = await client.post(`/folios/${folioId}/payments`, desk, { amount: 10, method: 'card', currency: 'GBP' });
      expect(res.status).toBe(400);
      expect(res.body.detail).toContain('No exchange rate is set for GBP');
    });

    it('counts foreign cash apart when the drawer is closed', async () => {
      const shift = await client.post(`/branches/${branch.id}/shifts/open`, desk, { shiftType: 'morning', openingFloat: 10_000 });
      expect(shift.status).toBe(201);
      expect((await client.post(`/folios/${folioId}/payments`, desk, { amount: 2, method: 'cash', currency: 'USD' })).status).toBe(201);
      expect((await client.post(`/folios/${folioId}/payments`, desk, { amount: 1_000, method: 'cash' })).status).toBe(201);
      const closed = await client.post(`/shifts/${shift.body.id}/close`, desk, { closingCashCounted: 11_000 });
      expect(closed.status).toBe(201);
      expect(Number(closed.body.systemCashTotal)).toBe(11_000);
      expect(closed.body.foreignCashTotals).toEqual([{ currency: 'USD', amount: '2.00' }]);
    });
  });

  describe('voiding a payment', () => {
    let folioId: string;
    beforeAll(async () => {
      folioId = await checkIn(client, owner, await book(client, owner, branch, 'Void Guest', lagosDay(0), lagosDay(1)), branch.rooms[2].id);
    });

    it('a supervisor voids a payment recorded in error: kept on record, owed again', async () => {
      const paid = await client.post(`/folios/${folioId}/payments`, desk, { amount: 20_000, method: 'card' });
      expect(Number((await bill(folioId)).totals.balanceDue)).toBe(0);
      expect((await client.post(`/payments/${paid.body.id}/void`, desk, { reason: 'Wrong bill' })).status).toBe(403);

      const voided = await client.post(`/payments/${paid.body.id}/void`, owner, { reason: 'Card declined after all' });
      expect(voided.status).toBe(200);
      expect(voided.body).toMatchObject({ isVoid: true, voidReason: 'Card declined after all' });
      const after = await bill(folioId);
      expect(Number(after.totals.balanceDue)).toBe(20_000);
      expect(after.payments.find((p) => p.id === paid.body.id)?.isVoid).toBe(true);
      expect((await client.post(`/payments/${paid.body.id}/void`, owner, { reason: 'Again' })).status).toBe(409);
      const audit = await inTenant(prisma, owner.tenantId, (tx) => tx.auditLog.findFirst({ where: { action: 'payment.voided', entityId: paid.body.id } }));
      expect(audit?.after).toMatchObject({ reason: 'Card declined after all', amount: '20000.00' });
    });

    it('refuses while a refund is asked for against it, and for money handed back', async () => {
      const paid = await client.post(`/folios/${folioId}/payments`, owner, { amount: 30_000, method: 'card' });
      const refund = await client.post(`/folios/${folioId}/refunds`, owner, { amount: 5_000, paymentId: paid.body.id, reason: 'Paid over' });
      expect(refund.status).toBe(201);
      const refused = await client.post(`/payments/${paid.body.id}/void`, owner, { reason: 'Mistake' });
      expect(refused.status).toBe(409);
      expect(refused.body.detail).toContain('refund has been asked for');
    });

    it('gives points back when a points payment is voided — without lifting the member’s tier', async () => {
      expect(
        (
          await client.put('/loyalty/program', owner, {
            isActive: true,
            currency: 'NGN',
            pointsPerUnit: 0.01,
            pointValue: 10,
            tiers: [
              { name: 'Member', threshold: 0, benefits: [] },
              { name: 'Gold', threshold: 1500, benefits: [] },
            ],
          })
        ).status,
      ).toBe(200);
      const guestId = (await client.get(`/folios/${folioId}`, owner)).body.guest.id as string;
      expect((await client.post(`/guests/${guestId}/loyalty/adjustments`, owner, { points: 1000, reason: 'Welcome gift' })).status).toBe(201);
      // Something left to pay with them, whatever the tests before left on the bill.
      expect((await client.post(`/folios/${folioId}/charges`, owner, { description: 'Spa', amount: 30_000, chargeType: 'spa' })).status).toBe(201);
      const owed = Number((await bill(folioId)).totals.balanceDue);
      expect(owed).toBeGreaterThan(0);
      const redeemed = await client.post(`/folios/${folioId}/loyalty-redemptions`, owner, { points: Math.min(1000, Math.floor(owed / 10)) });
      expect(redeemed.status).toBe(201);
      const spent = redeemed.body.pointsRedeemed as number;

      expect((await client.post(`/payments/${redeemed.body.paymentId}/void`, owner, { reason: 'Guest wants to keep the points' })).status).toBe(200);
      const loyalty = (await client.get(`/guests/${guestId}/loyalty`, owner)).body as { balance: number; lifetimePoints: number; tierName: string | null };
      expect(loyalty.balance).toBe(1000);
      // The 1,000 added, not 1,000 + the points that came back.
      expect(loyalty.lifetimePoints).toBe(1000);
      expect(loyalty.tierName).toBe('Member');
      expect(spent).toBeGreaterThan(0);
    });

    it('refuses cash that went into a drawer already counted and closed', async () => {
      const shift = await client.post(`/branches/${branch.id}/shifts/open`, desk, { shiftType: 'evening', openingFloat: 0 });
      const cash = await client.post(`/folios/${folioId}/payments`, desk, { amount: 500, method: 'cash' });
      expect((await client.post(`/shifts/${shift.body.id}/close`, desk, { closingCashCounted: 500 })).status).toBe(201);
      const refused = await client.post(`/payments/${cash.body.id}/void`, owner, { reason: 'Mistake' });
      expect(refused.status).toBe(409);
      expect(refused.body.detail).toContain('counted and closed');
    });
  });

  describe('invoices', () => {
    it('numbers invoices per property, gives the same one back when nothing changed, and replaces it when something did', async () => {
      const folioId = await checkIn(client, owner, await book(client, owner, branch, 'Invoice Guest', lagosDay(0), lagosDay(1)), branch.rooms[3].id);
      const year = lagosDay(0).slice(0, 4);
      const first = await client.post(`/folios/${folioId}/invoices`, desk);
      expect(first.status).toBe(201);
      expect(first.body.number).toMatch(new RegExp(`^INV-${year}-\\d{5}$`));
      expect(first.body.lines).toEqual([expect.objectContaining({ chargeType: 'room', amount: '20000.00' })]);

      const again = await client.post(`/folios/${folioId}/invoices`, desk);
      expect(again.body.id).toBe(first.body.id);

      expect((await client.post(`/folios/${folioId}/charges`, desk, { description: 'Minibar', amount: 3_000, chargeType: 'minibar' })).status).toBe(201);
      const second = await client.post(`/folios/${folioId}/invoices`, desk);
      expect(second.body.id).not.toBe(first.body.id);
      expect(Number(second.body.number.slice(-5))).toBe(Number(first.body.number.slice(-5)) + 1);
      expect(second.body.supersedes).toEqual({ id: first.body.id, number: first.body.number });
      expect(second.body.totals.total).toBe('23000.00');

      const list = (await client.get(`/folios/${folioId}/invoices`, owner)).body as Array<{ id: string; supersededAt: string | null; supersededBy: { id: string } | null }>;
      expect(list.map((i) => i.id)).toEqual([second.body.id, first.body.id]);
      expect(list[1].supersededBy?.id).toBe(second.body.id);

      const pdf = await request(app.getHttpServer())
        .get(`/api/v1/invoices/${second.body.id}/pdf`)
        .set({ Authorization: `Bearer ${owner.token}`, 'X-Tenant-ID': owner.tenantId })
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    });
  });

  describe('check-out fees and receivables', () => {
    it('charges the early departure fee, which a manager can waive and the desk cannot', async () => {
      expect((await client.patch(`/branches/${branch.id}/policies/stay-fees`, owner, { earlyDeparture: { feeType: 'flat', amount: 5_000 } })).status).toBe(200);
      const leaving = await book(client, owner, branch, 'Leaves Early', lagosDay(0), lagosDay(3));
      const folioId = await checkIn(client, owner, leaving, branch.rooms[4].id);
      const quote = await client.get(`/reservations/${leaving}/check-out-quote`, desk);
      expect(quote.body.fees).toEqual([expect.objectContaining({ kind: 'early_departure', amount: '5000.00', description: 'Early departure fee (3 nights given up)' })]);

      expect((await client.post(`/reservations/${leaving}/check-out`, desk, { waiveFees: true, waiverReason: 'Nice guest' })).status).toBe(403);
      expect((await client.post(`/reservations/${leaving}/check-out`, desk, {})).status).toBe(201);
      const after = await bill(folioId);
      expect(after.lineItems.filter((l) => l.chargeType === 'penalty').map((l) => [l.description, l.amount])).toEqual([['Early departure fee (3 nights given up)', '5000']]);

      const waived = await book(client, owner, branch, 'Waived Early', lagosDay(0), lagosDay(3));
      const waivedFolio = await checkIn(client, owner, waived, branch.rooms[5].id);
      expect((await client.post(`/reservations/${waived}/check-out`, owner, { waiveFees: true, waiverReason: 'Family emergency' })).status).toBe(201);
      expect((await bill(waivedFolio)).lineItems.some((l) => l.chargeType === 'penalty')).toBe(false);
      expect((await client.patch(`/branches/${branch.id}/policies/stay-fees`, owner, { earlyDeparture: null })).status).toBe(200);
    });

    it('ages what departed guests and companies owe, by who owes it', async () => {
      const company = await client.post('/corporate-accounts', owner, { name: `Ageing Co ${Date.now()}`, paymentTermsDays: 30 });
      expect(company.status).toBe(201);
      const stay = await book(client, owner, branch, 'Company Traveller', lagosDay(0), lagosDay(1));
      await checkIn(client, owner, stay, branch.rooms[6].id);
      const companyBill = await client.post(`/reservations/${stay}/folios`, owner, { label: 'Company', corporateAccountId: company.body.id });
      expect(companyBill.status).toBe(201);
      expect((await client.post(`/folios/${companyBill.body.id}/charges`, owner, { description: 'Conference fee', amount: 50_000, chargeType: 'misc' })).status).toBe(201);
      expect((await client.post(`/reservations/${stay}/check-out`, owner, {})).status).toBe(201);
      const invoice = await client.post(`/folios/${companyBill.body.id}/invoices`, owner);
      expect(invoice.body.dueDate).toBe(addDays(lagosDay(0), 30));

      const report = await client.get(`/branches/${branch.id}/reports/ar-ageing`, owner);
      expect(report.status).toBe(200);
      const debtor = (report.body.debtors as Array<{ type: string; name: string; total: string; buckets: Record<string, string>; bills: Array<{ invoice: { number: string } | null }> }>).find(
        (d) => d.name === company.body.name,
      );
      expect(debtor).toMatchObject({ type: 'company', total: '50000.00', buckets: { '0-30': '50000.00', '31-60': '0.00', '61-90': '0.00', '90+': '0.00' } });
      expect(debtor?.bills[0].invoice?.number).toBe(invoice.body.number);
      // A month on, the same bill is 31–60 days old.
      const later = await client.get(`/branches/${branch.id}/reports/ar-ageing?asOf=${addDays(lagosDay(0), 45)}`, owner);
      expect((later.body.debtors as Array<{ name: string; buckets: Record<string, string> }>).find((d) => d.name === company.body.name)?.buckets['31-60']).toBe('50000.00');
      expect((await client.get(`/branches/${branch.id}/reports/ar-ageing`, desk)).status).toBe(403);
    });
  });

  describe('billing an event', () => {
    it('puts the space hire and the catering on a guest’s bill, once', async () => {
      const space = await client.post(`/branches/${branch.id}/event-spaces`, owner, { name: 'Boardroom', category: 'meeting_room', capacity: 20 });
      expect(space.status).toBe(201);
      const startsAt = `${lagosDay(1)}T09:00:00.000Z`;
      const event = await client.post(`/event-spaces/${space.body.id}/bookings`, owner, {
        title: 'Board Meeting',
        startsAt,
        endsAt: `${lagosDay(1)}T15:00:00.000Z`,
        spaceHireFee: 100_000,
        catering: [{ description: 'Lunch', quantity: 10, unitPrice: 5_000 }],
      });
      expect(event.status).toBe(201);
      expect(event.body.spaceHireFee).toBe('100000.00');

      const host = await checkIn(client, owner, await book(client, owner, branch, 'Meeting Host', lagosDay(0), lagosDay(2)), branch.rooms[7].id);
      const billed = await client.post(`/event-bookings/${event.body.id}/bill`, desk, { folioId: host });
      expect(billed.status).toBe(201);
      expect(billed.body.billedTo).toMatchObject({ folioId: host, guestName: 'Meeting Host' });
      expect(billed.body.totals).toMatchObject({ hire: '100000.00', catering: '50000.00', subtotal: '150000.00' });
      const lines = (await bill(host)).lineItems.map((l) => [l.description, l.chargeType, l.amount]);
      expect(lines).toEqual(
        expect.arrayContaining([
          ['Board Meeting — hire of Boardroom', 'misc', '100000'],
          ['Board Meeting — Lunch × 10', 'fnb', '50000'],
        ]),
      );

      expect((await client.post(`/event-bookings/${event.body.id}/bill`, desk, { folioId: host })).status).toBe(409);
      expect((await client.patch(`/event-bookings/${event.body.id}`, owner, { spaceHireFee: 1 })).status).toBe(409);
    });
  });
});
