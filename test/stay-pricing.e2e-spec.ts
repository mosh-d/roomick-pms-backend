import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, book, BranchLayout, checkIn, Client, deleteOrganisation, headBrand, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * Pricing a stay beyond the room rate: extra adults and children, packages,
 * day use, channel allotments — and reports that file each night under the
 * room type it was sold as.
 */
describe('Stay pricing (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let branch: BranchLayout;
  let slug: string;

  const lines = async (folioId: string) =>
    (
      (await client.get(`/folios/${folioId}`, owner)).body as {
        lineItems: Array<{ description: string; amount: string; chargeType: string; dayUse: boolean; packageId: string | null; serviceDate: string }>;
      }
    ).lineItems;

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Stay Pricing');
    branch = await addBranch(client, owner, await headBrand(client, owner), 'Pricing Branch', 8);
    slug = `e2e-pricing-${Date.now()}`;
    expect((await client.put(`/branches/${branch.id}/booking-engine`, owner, { slug })).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it('charges extra adults and children a night, in the quote and the booking alike', async () => {
    const patched = await client.patch(`/room-types/${branch.roomTypeId}`, owner, {
      capacity: { adults: 4, children: 2 },
      adultsIncluded: 2,
      extraAdultRate: 10_000,
      childrenIncluded: 0,
      childRate: 5_000,
    });
    expect(patched.status).toBe(200);
    const quote = await client.post(`/branches/${branch.id}/rate-resolver/calculate`, owner, {
      roomTypeId: branch.roomTypeId,
      checkInDate: lagosDay(30),
      checkOutDate: lagosDay(32),
      adults: 3,
      children: 1,
    });
    // Two nights of 20,000 + one extra adult (10,000) + one child (5,000).
    expect(quote.body.subtotal).toBe('70000');
    expect(quote.body.occupancySurcharge).toBe('15000');

    const booked = await client.post(`/branches/${branch.id}/reservations`, owner, {
      guest: { name: 'Big Family', email: `family.${Date.now()}@example.com` },
      roomTypeId: branch.roomTypeId,
      checkInDate: lagosDay(30),
      checkOutDate: lagosDay(32),
      adults: 3,
      children: 1,
    });
    expect(booked.status).toBe(201);
    expect(Number(booked.body.confirmedRate)).toBe(70_000);

    const online = await client.get(`/public/properties/${slug}/quote?roomTypeId=${branch.roomTypeId}&checkInDate=${lagosDay(30)}&checkOutDate=${lagosDay(32)}&adults=2&children=0`, null);
    expect(online.body.subtotal).toBe('40000.00');
    // Back to the plain rate for the tests below.
    expect((await client.patch(`/room-types/${branch.roomTypeId}`, owner, { adultsIncluded: null, childRate: null, extraAdultRate: null })).status).toBe(200);
  });

  it('adds packages to a stay and posts them with the night, and the per-stay one once', async () => {
    const breakfast = await client.post(`/branches/${branch.id}/packages`, owner, { name: 'Breakfast', price: 5_000, basis: 'per_person_per_night', chargeType: 'fnb' });
    const transfer = await client.post(`/branches/${branch.id}/packages`, owner, { name: 'Airport pick-up', price: 15_000, basis: 'per_stay', chargeType: 'transport', showOnline: false });
    expect(breakfast.status).toBe(201);
    expect(transfer.status).toBe(201);

    const booked = await client.post(`/branches/${branch.id}/reservations`, owner, {
      guest: { name: 'Package Guest', email: `package.${Date.now()}@example.com` },
      roomTypeId: branch.roomTypeId,
      checkInDate: lagosDay(0),
      checkOutDate: lagosDay(2),
      adults: 2,
      packageIds: [breakfast.body.id, transfer.body.id],
    });
    expect(booked.status).toBe(201);
    expect(booked.body.packages).toEqual([
      expect.objectContaining({ name: 'Breakfast', price: '5000.00', basis: 'per_person_per_night' }),
      expect.objectContaining({ name: 'Airport pick-up', price: '15000.00', basis: 'per_stay' }),
    ]);
    const folioId = await checkIn(client, owner, booked.body.id, branch.rooms[0].id);
    const posted = (await lines(folioId)).filter((l) => l.packageId).map((l) => [l.chargeType, l.amount]);
    expect(posted).toEqual(expect.arrayContaining([['fnb', '10000'], ['transport', '15000']]));
    expect(posted).toHaveLength(2);

    // Online, only what's offered online — and priced into the quote.
    const offered = (await client.get(`/public/properties/${slug}/packages?roomTypeId=${branch.roomTypeId}`, null)).body as Array<{ id: string }>;
    expect(offered.map((p) => p.id)).toEqual([breakfast.body.id]);
    const quote = await client.get(
      `/public/properties/${slug}/quote?roomTypeId=${branch.roomTypeId}&checkInDate=${lagosDay(40)}&checkOutDate=${lagosDay(42)}&adults=2&packageIds=${breakfast.body.id}`,
      null,
    );
    expect(quote.body.packages.subtotal).toBe('20000.00');
    expect(quote.body.grandTotal).toBe('60000.00');
    const refused = await client.get(
      `/public/properties/${slug}/quote?roomTypeId=${branch.roomTypeId}&checkInDate=${lagosDay(40)}&checkOutDate=${lagosDay(42)}&adults=2&packageIds=${transfer.body.id}`,
      null,
    );
    expect(refused.status).toBe(400);

    // The desk's own quote prices them too — desk-only ones included.
    const desk = await client.post(`/branches/${branch.id}/rate-resolver/calculate`, owner, {
      roomTypeId: branch.roomTypeId,
      checkInDate: lagosDay(40),
      checkOutDate: lagosDay(42),
      adults: 2,
      packageIds: [breakfast.body.id, transfer.body.id],
    });
    expect(desk.status).toBe(201);
    expect(desk.body.packages.subtotal).toBe('35000.00');
    expect(desk.body.grandTotal).toBe('75000.00');
  });

  it('a package added to a stay under way is charged from today, never for the nights already past', async () => {
    const dinner = await client.post(`/branches/${branch.id}/packages`, owner, { name: 'Dinner', price: 4_000, basis: 'per_night', chargeType: 'fnb' });
    const spa = await client.post(`/branches/${branch.id}/packages`, owner, { name: 'Spa visit', price: 9_000, basis: 'per_stay', chargeType: 'spa' });
    const stay = await book(client, owner, branch, 'Mid Stay', lagosDay(0), lagosDay(2));
    const folioId = await checkIn(client, owner, stay, branch.rooms[3].id);
    // The stay began two days ago.
    await inTenant(prisma, owner.tenantId, (tx) => tx.reservation.update({ where: { id: stay }, data: { checkInDate: new Date(`${lagosDay(-2)}T00:00:00.000Z`) } }));

    const set = await client.put(`/reservations/${stay}/packages`, owner, { packageIds: [dinner.body.id, spa.body.id] });
    expect(set.status).toBe(200);
    expect(set.body.packages).toEqual([expect.objectContaining({ name: 'Dinner', addedOn: lagosDay(0) }), expect.objectContaining({ name: 'Spa visit', addedOn: lagosDay(0) })]);
    const posted = () => lines(folioId).then((all) => all.filter((l) => l.packageId).map((l) => [l.chargeType, l.amount, l.serviceDate.slice(0, 10)]));
    expect(await posted()).toEqual(expect.arrayContaining([['fnb', '4000', lagosDay(0)], ['spa', '9000', lagosDay(0)]]));
    expect(await posted()).toHaveLength(2);

    // Leaving today bills the two nights before check-in's own — but not the dinner for them.
    expect((await client.post(`/reservations/${stay}/check-out`, owner, {})).status).toBe(201);
    expect((await lines(folioId)).filter((l) => l.chargeType === 'room').map((l) => l.serviceDate.slice(0, 10))).toEqual(
      expect.arrayContaining([lagosDay(-2), lagosDay(-1), lagosDay(0)]),
    );
    expect(await posted()).toHaveLength(2);
  });

  it('sells a room for the day: one charge, no night, and the night still on sale', async () => {
    expect((await client.get(`/branches/${branch.id}/booking-options`, owner)).body).toEqual({ dayUseHours: null, currency: 'NGN' });
    expect((await client.patch(`/branches/${branch.id}/policies/day-use`, owner, { enabled: true, from: '10:00', until: '17:00' })).status).toBe(200);
    expect((await client.get(`/branches/${branch.id}/booking-options`, owner)).body).toEqual({ dayUseHours: { from: '10:00', until: '17:00' }, currency: 'NGN' });
    const noRate = await client.post(`/branches/${branch.id}/reservations`, owner, {
      guest: { name: 'Day Guest', email: `day.${Date.now()}@example.com` },
      roomTypeId: branch.roomTypeId,
      checkInDate: lagosDay(0),
      checkOutDate: lagosDay(0),
      adults: 1,
      dayUse: true,
    });
    expect(noRate.status).toBe(400);
    expect((await client.patch(`/room-types/${branch.roomTypeId}`, owner, { dayUseRate: 8_000 })).status).toBe(200);

    const before = (await client.get(`/branches/${branch.id}/availability?from=${lagosDay(0)}&to=${lagosDay(1)}&roomTypeId=${branch.roomTypeId}`, owner)).body as Array<{ available: number }>;
    const booked = await client.post(`/branches/${branch.id}/reservations`, owner, {
      guest: { name: 'Day Guest', email: `day.${Date.now()}@example.com` },
      roomTypeId: branch.roomTypeId,
      checkInDate: lagosDay(0),
      checkOutDate: lagosDay(5),
      adults: 1,
      dayUse: true,
    });
    expect(booked.status).toBe(201);
    expect(booked.body).toMatchObject({ isDayUse: true, confirmedRate: '8000' });
    expect(booked.body.checkOutDate).toBe(booked.body.checkInDate);
    const after = (await client.get(`/branches/${branch.id}/availability?from=${lagosDay(0)}&to=${lagosDay(1)}&roomTypeId=${branch.roomTypeId}`, owner)).body as Array<{ available: number }>;
    expect(after[0].available).toBe(before[0].available);

    const lunch = await client.post(`/branches/${branch.id}/packages`, owner, { name: 'Lunch', price: 3_000, basis: 'per_person_per_night', chargeType: 'fnb' });
    expect((await client.put(`/reservations/${booked.body.id}/packages`, owner, { packageIds: [lunch.body.id] })).status).toBe(200);
    const folioId = await checkIn(client, owner, booked.body.id, branch.rooms[1].id);
    const charged = (await lines(folioId)).filter((l) => l.chargeType === 'room');
    expect(charged).toEqual([expect.objectContaining({ amount: '8000', dayUse: true })]);
    // The day counts as the one night a per-night package is charged for.
    expect((await lines(folioId)).filter((l) => l.packageId === lunch.body.id).map((l) => l.amount)).toEqual(['3000']);
    expect((await client.patch(`/reservations/${booked.body.id}/modify`, owner, { checkInDate: lagosDay(1), reason: 'Move it' })).status).toBe(409);
    expect((await client.post(`/reservations/${booked.body.id}/check-out`, owner, {})).status).toBe(201);
  });

  it('a channel sells no more than its allotment', async () => {
    const allotment = await client.post(`/branches/${branch.id}/channel-allotments`, owner, {
      roomTypeId: branch.roomTypeId,
      channel: 'website',
      fromDate: lagosDay(50),
      toDate: lagosDay(55),
      rooms: 1,
    });
    expect(allotment.status).toBe(201);
    const online = (name: string) =>
      client.post(`/public/properties/${slug}/reservations`, null, {
        roomTypeId: branch.roomTypeId,
        checkInDate: lagosDay(51),
        checkOutDate: lagosDay(53),
        adults: 1,
        guestName: name,
        guestEmail: `${name.toLowerCase().replace(' ', '.')}.${Date.now()}@example.com`,
        acceptTerms: true,
      });
    expect((await online('First Online')).status).toBe(201);
    const second = await online('Second Online');
    expect(second.status).toBe(409);
    expect(second.body.detail).toContain('Website allotment');
    // The desk still sells from the whole house.
    expect(await book(client, owner, branch, 'Desk Booking', lagosDay(51), lagosDay(53))).toEqual(expect.any(String));
    const booked = await inTenant(prisma, owner.tenantId, (tx) => tx.reservation.findMany({ where: { branchId: branch.id, channel: 'website' }, select: { id: true } }));
    expect(booked).toHaveLength(1);
  });

  it('reports a night under the room type it was sold as, after the guest moves', async () => {
    const suite = await client.post(`/branches/${branch.id}/room-types`, owner, { name: 'Suite', baseRate: 50_000, capacity: { adults: 2, children: 0 } });
    expect((await client.post(`/branches/${branch.id}/rooms/bulk`, owner, { roomTypeId: suite.body.id, range: { from: 901, to: 901 } })).status).toBe(201);
    const suiteRoom = ((await client.get(`/branches/${branch.id}/rooms`, owner)).body as Array<{ id: string; number: string }>).find((r) => r.number === '901');
    const stay = await book(client, owner, branch, 'Upgraded Guest', lagosDay(0), lagosDay(2));
    await checkIn(client, owner, stay, branch.rooms[2].id);
    const moved = await client.patch(`/reservations/${stay}/move-room`, owner, { roomId: suiteRoom!.id, reason: 'Upgrade', chargeNewRate: false });
    expect(moved.status).toBe(200);

    const report = await client.get(`/branches/${branch.id}/reports/occupancy?from=${lagosDay(0)}&to=${lagosDay(1)}`, owner);
    const byType = report.body.byRoomType as Array<{ roomTypeId: string; roomNightsSold: number }>;
    const standardSold = byType.find((r) => r.roomTypeId === branch.roomTypeId)?.roomNightsSold ?? 0;
    const suiteSold = byType.find((r) => r.roomTypeId === suite.body.id)?.roomNightsSold ?? 0;
    // Tonight was billed at check-in as a standard night: it stays one, though the stay is now a suite.
    expect(suiteSold).toBe(0);
    expect(standardSold).toBeGreaterThanOrEqual(1);
  });
});
