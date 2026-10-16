import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, book, BranchLayout, Client, deleteOrganisation, headBrand, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * The standard features where they meet each other and the rest of the
 * hotel: an allotment and the booking page, a day-use booking at the night
 * audit, a deposit through a late cancellation and its refund.
 */
describe('Standard features together (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let branch: BranchLayout;
  let slug: string;

  const primaryFolio = async (reservationId: string) =>
    ((await client.get(`/reservations/${reservationId}/folios`, owner)).body as Array<{ id: string; label: string | null; status: string }>).find((f) => f.label === null);
  const bill = async (folioId: string) =>
    (await client.get(`/folios/${folioId}`, owner)).body as {
      status: string;
      guestStatus: string | null;
      totals: { balanceDue: string };
      lineItems: Array<{ description: string; amount: string; chargeType: string }>;
    };

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Interplay');
    branch = await addBranch(client, owner, await headBrand(client, owner), 'Interplay Branch', 6);
    slug = `e2e-interplay-${Date.now()}`;
    expect((await client.put(`/branches/${branch.id}/booking-engine`, owner, { slug })).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it('the booking page offers no more rooms than the website’s allotment leaves', async () => {
    expect(
      (
        await client.post(`/branches/${branch.id}/channel-allotments`, owner, {
          roomTypeId: branch.roomTypeId,
          channel: 'website',
          fromDate: lagosDay(70),
          toDate: lagosDay(71),
          rooms: 1,
        })
      ).status,
    ).toBe(201);
    const shown = async () => {
      const one = (await client.get(`/public/properties/${slug}/availability?from=${lagosDay(70)}&to=${lagosDay(72)}&roomTypeId=${branch.roomTypeId}`)).body as Array<{
        nights: Array<{ date: string; available: number }>;
      }>;
      const all = (await client.get(`/public/properties/${slug}/availability?from=${lagosDay(70)}&to=${lagosDay(72)}`)).body as Array<{
        roomTypeId: string;
        nights: Array<{ date: string; available: number }>;
      }>;
      return { one: one[0].nights.map((n) => n.available), all: all.find((t) => t.roomTypeId === branch.roomTypeId)!.nights.map((n) => n.available) };
    };
    // Six rooms, but the website may sell one a night.
    expect(await shown()).toEqual({ one: [1, 1], all: [1, 1] });
    const booked = await client.post(`/public/properties/${slug}/reservations`, null, {
      roomTypeId: branch.roomTypeId,
      checkInDate: lagosDay(70),
      checkOutDate: lagosDay(72),
      adults: 1,
      guestName: 'Online Guest',
      guestEmail: `online.${Date.now()}@example.com`,
      acceptTerms: true,
    });
    expect(booked.status).toBe(201);
    // The allotment is used up: the page says so, rather than taking the guest's details and refusing at the end.
    expect(await shown()).toEqual({ one: [0, 0], all: [0, 0] });
    // The desk still sees the house.
    const desk = (await client.get(`/branches/${branch.id}/availability?from=${lagosDay(70)}&to=${lagosDay(72)}&roomTypeId=${branch.roomTypeId}`, owner)).body as Array<{
      available: number;
    }>;
    expect(desk.map((n) => n.available)).toEqual([5, 5]);
  });

  it('a day-use booking nobody arrived for is a no-show at the night audit, charged the day’s rate', async () => {
    expect((await client.patch(`/branches/${branch.id}/policies/day-use`, owner, { enabled: true, from: '10:00', until: '17:00' })).status).toBe(200);
    expect((await client.patch(`/room-types/${branch.roomTypeId}`, owner, { dayUseRate: 8_000 })).status).toBe(200);
    expect((await client.patch(`/branches/${branch.id}/policies/no-show`, owner, { defaultPenalty: 'first_night', autoMark: true })).status).toBe(200);
    const booked = await client.post(`/branches/${branch.id}/reservations`, owner, {
      guest: { name: 'Day No Show', email: `day.noshow.${Date.now()}@example.com` },
      roomTypeId: branch.roomTypeId,
      checkInDate: lagosDay(0),
      checkOutDate: lagosDay(0),
      adults: 1,
      dayUse: true,
    });
    expect(booked.status).toBe(201);
    // Booked for a day already past.
    await inTenant(prisma, owner.tenantId, (tx) =>
      tx.reservation.update({ where: { id: booked.body.id }, data: { checkInDate: new Date(`${lagosDay(-1)}T00:00:00.000Z`), checkOutDate: new Date(`${lagosDay(-1)}T00:00:00.000Z`) } }),
    );
    const audit = await client.post(`/branches/${branch.id}/night-audit/run`, owner, { auditDate: lagosDay(-1) });
    expect(audit.status).toBe(201);
    expect(audit.body.errors ?? []).toEqual([]);
    expect((await client.get(`/reservations/${booked.body.id}`, owner)).body.status).toBe('no_show');
    const folio = await primaryFolio(booked.body.id);
    expect((await bill(folio!.id)).lineItems.filter((l) => l.chargeType === 'penalty').map((l) => l.amount)).toEqual(['8000']);
  });

  it('leaving on the day they arrived, a guest gives up only the nights not already billed', async () => {
    expect((await client.patch(`/branches/${branch.id}/policies/stay-fees`, owner, { earlyDeparture: { feeType: 'first_night' } })).status).toBe(200);
    // Two nights from today; the first was billed at check-in.
    const id = await book(client, owner, branch, 'Leaves Same Day', lagosDay(0), lagosDay(2));
    expect((await client.post(`/reservations/${id}/check-in`, owner, { roomId: branch.rooms[5].id })).status).toBe(201);
    const quote = await client.get(`/reservations/${id}/check-out-quote`, owner);
    expect(quote.body.fees).toEqual([expect.objectContaining({ kind: 'early_departure', amount: '20000.00', description: 'Early departure fee (1 night given up)' })]);
    expect((await client.patch(`/branches/${branch.id}/policies/stay-fees`, owner, { earlyDeparture: null })).status).toBe(200);
  });

  it('a deposit is set against a late cancellation’s charge, and what’s left over goes back', async () => {
    expect((await client.patch(`/branches/${branch.id}/policies/cancellation`, owner, { freeCancellationHours: 24, lateCancellationPenalty: 'first_night', allowOnlineCancellation: true })).status).toBe(200);
    expect((await client.patch(`/branches/${branch.id}/policies/deposit`, owner, { type: 'fixed', value: 30_000, dueDaysBeforeArrival: 0 })).status).toBe(200);
    // Arriving today: inside the free-cancellation window, so cancelling costs the first night.
    const id = await book(client, owner, branch, 'Late Canceller', lagosDay(0), lagosDay(2));
    expect((await client.get(`/reservations/${id}`, owner)).body.depositAmount).toBe('30000');
    expect((await client.post(`/reservations/${id}/deposits`, owner, { amount: 30_000, method: 'card' })).status).toBe(201);
    expect((await primaryFolio(id))!.status).toBe('pending');

    expect((await client.post(`/reservations/${id}/cancel`, owner, { reason: 'Plans changed' })).status).toBe(201);
    const folio = await primaryFolio(id);
    const after = await bill(folio!.id);
    // 20,000 for the first night against 30,000 paid: 10,000 is the guest's.
    expect(after.lineItems.filter((l) => l.chargeType === 'penalty').map((l) => l.amount)).toEqual(['20000']);
    expect(after.totals.balanceDue).toBe('-10000');
    expect(after.guestStatus).toBe('refund_due');
    expect(after.status).toBe('open');

    const refund = await client.post(`/folios/${folio!.id}/refunds`, owner, { amount: 10_000, method: 'card', reason: 'What the cancellation charge left' });
    expect(refund.status).toBe(201);
    expect((await client.post(`/refunds/${refund.body.id}/pay-out`, owner, {})).status).toBe(201);
    const settled = await bill(folio!.id);
    expect(settled.totals.balanceDue).toBe('0');
    expect(settled.status).toBe('settled');
  });
});
