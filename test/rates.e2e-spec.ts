import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, addDays, BranchLayout, Client, deleteOrganisation, headBrand, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * Rate plans, quotes and recommendations — third audit, M1, L2, M4, M5, L29.
 *
 * A rate plan could price a night at −100 (and the public booking page quoted
 * it), a plan could end before it started (a 500), a four-year quote took
 * seconds and wrote a trail row per night, and approving a recommendation for
 * one date priced the next night too.
 */
describe('Rates (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let branch: BranchLayout;
  let slug: string;

  const quote = (checkInDate: string, checkOutDate: string) =>
    client.post(`/branches/${branch.id}/rate-resolver/calculate`, owner, { roomTypeId: branch.roomTypeId, checkInDate, checkOutDate });
  const plan = (body: Record<string, unknown>) => client.post(`/branches/${branch.id}/rate-plans`, owner, body);
  const trailRows = () => inTenant(prisma, owner.tenantId, (tx) => tx.rateAuditLog.count());

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Rates');
    branch = await addBranch(client, owner, await headBrand(client, owner), 'Rate Branch', 4, 20_000);
    slug = `e2e-rates-${Date.now()}`;
    expect((await client.put(`/branches/${branch.id}/booking-engine`, owner, { slug })).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it('refuses a promotional or negotiated price of zero or less — it is the nightly price itself', async () => {
    for (const body of [
      { name: 'Negative promo', type: 'promotional', amount: -100, promoCode: 'NEG' },
      { name: 'Zero promo', type: 'promotional', amount: 0, promoCode: 'ZERO' },
      { name: 'Negative deal', type: 'negotiated', amount: -5 },
    ]) {
      const res = await plan(body);
      expect(res.status).toBe(400);
    }
  });

  it('refuses a −100% or +1500% change, and a plan that ends before it starts (was a 500)', async () => {
    expect((await plan({ name: 'Free', type: 'seasonal', amount: -100, adjustmentType: 'percentage', validFrom: lagosDay(40), validTo: lagosDay(41) })).status).toBe(400);
    expect((await plan({ name: 'Typo', type: 'seasonal', amount: 1500, adjustmentType: 'percentage', validFrom: lagosDay(40), validTo: lagosDay(41) })).status).toBe(400);
    const backwards = await plan({ name: 'Backwards', type: 'seasonal', amount: 10, adjustmentType: 'percentage', validFrom: lagosDay(10), validTo: lagosDay(5) });
    expect(backwards.status).toBe(400);
    expect(backwards.body.detail).toMatch(/ends before it starts/);
  });

  it('refuses to price a night at zero or less — staff quote, public quote and public booking', async () => {
    const night = lagosDay(80);
    expect((await plan({ name: 'Big cut', type: 'seasonal', amount: -25_000, adjustmentType: 'fixed', validFrom: night, validTo: night })).status).toBe(201);
    const staff = await quote(night, addDays(night, 1));
    expect(staff.status).toBe(400);
    expect(staff.body.detail).toMatch(new RegExp(`rate for ${night}`));
    const publicQuote = await client.get(`/public/properties/${slug}/quote?roomTypeId=${branch.roomTypeId}&checkInDate=${night}&checkOutDate=${addDays(night, 1)}`);
    expect(publicQuote.status).toBe(400);
    const publicBooking = await client.post(`/public/properties/${slug}/reservations`, null, {
      roomTypeId: branch.roomTypeId,
      checkInDate: night,
      checkOutDate: addDays(night, 1),
      adults: 1,
      guestName: 'Free Rider',
      guestEmail: `free.${Date.now()}@example.com`,
      acceptTerms: true,
    });
    expect(publicBooking.status).toBe(400);
  });

  it('caps a stay at 92 nights — refused before a single trail row is written (was 3.4 s and 1,461 rows)', async () => {
    const from = lagosDay(100);
    const rowsBefore = await trailRows();
    expect((await quote(from, addDays(from, 1461))).status).toBe(400);
    expect((await quote(from, addDays(from, 93))).status).toBe(400);
    expect(await trailRows()).toBe(rowsBefore);
    expect((await quote(from, addDays(from, 92))).status).toBe(201);

    const longBooking = await client.post(`/branches/${branch.id}/reservations`, owner, {
      guest: { name: 'Long Stayer', email: `long.${Date.now()}@example.com` },
      roomTypeId: branch.roomTypeId,
      checkInDate: from,
      checkOutDate: addDays(from, 100),
      adults: 1,
    });
    expect(longBooking.status).toBe(400);
    const publicLong = await client.get(`/public/properties/${slug}/quote?roomTypeId=${branch.roomTypeId}&checkInDate=${from}&checkOutDate=${addDays(from, 1461)}`);
    expect(publicLong.status).toBe(400);
  });

  it('approving a recommendation for one date prices that night only', async () => {
    const day = lagosDay(70);
    const approved = await client.post(`/branches/${branch.id}/rate-recommendations/approve`, owner, { roomTypeId: branch.roomTypeId, date: day, adjustmentPct: 25 });
    expect(approved.status).toBe(201);
    expect(String(approved.body.validFrom).slice(0, 10)).toBe(day);
    expect(String(approved.body.validTo).slice(0, 10)).toBe(day);
    expect(Number((await quote(day, addDays(day, 1))).body.subtotal)).toBe(25_000);
    expect(Number((await quote(addDays(day, 1), addDays(day, 2))).body.subtotal)).toBe(20_000);
  });

  it('says which currency the rate plans and recommendations are in', async () => {
    const plans = await client.get(`/branches/${branch.id}/rate-plans`, owner);
    expect(plans.status).toBe(200);
    expect((plans.body as Array<{ currency: string }>).length).toBeGreaterThan(0);
    for (const p of plans.body as Array<{ currency: string }>) expect(p.currency).toBe('NGN');
    const recommendations = await client.get(`/branches/${branch.id}/rate-recommendations?roomTypeId=${branch.roomTypeId}&horizonDays=14`, owner);
    expect(recommendations.status).toBe(200);
    for (const r of recommendations.body as Array<{ currency: string }>) expect(r.currency).toBe('NGN');
  });
});
