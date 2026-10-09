import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, addDays, book, BranchLayout, checkIn, Client, deleteOrganisation, headBrand, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * A hotel day, step after step — what the fourth audit found when it ran
 * whole workflows rather than single routes: records that each looked right
 * but disagreed with one another.
 */
describe('A hotel day (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let brandId: string;
  let branch: BranchLayout;
  const today = lagosDay(0);
  const yesterday = lagosDay(-1);

  /** Moves a checked-in stay to have arrived yesterday — the API takes no back-dated check-in. */
  const arrivedYesterday = (reservationId: string) =>
    inTenant(prisma, owner.tenantId, (tx) =>
      tx.reservation.update({ where: { id: reservationId }, data: { checkInDate: new Date(`${yesterday}T00:00:00.000Z`), actualCheckIn: new Date(`${yesterday}T14:00:00.000Z`) } }),
    );

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Hotel Day');
    brandId = await headBrand(client, owner);
    branch = await addBranch(client, owner, brandId, 'Day Branch', 6, 20_000);
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it("check-out retires the room's waiting stay-over service, so the board shows one job for the room", async () => {
    const reservationId = await book(client, owner, branch, 'Leaving Guest', today, lagosDay(2));
    await checkIn(client, owner, reservationId, branch.rooms[0].id);
    await arrivedYesterday(reservationId);
    expect((await client.post(`/branches/${branch.id}/night-audit/run`, owner, { auditDate: yesterday })).status).toBe(201);
    const tasks = () => inTenant(prisma, owner.tenantId, (tx) => tx.housekeepingTask.findMany({ where: { roomId: branch.rooms[0].id }, select: { triggerEvent: true, status: true } }));
    expect(await tasks()).toEqual([{ triggerEvent: 'stayover', status: 'pending' }]);

    expect((await client.post(`/reservations/${reservationId}/check-out`, owner)).status).toBe(201);
    const after = await tasks();
    expect(after.filter((t) => t.status === 'pending')).toEqual([{ triggerEvent: 'checkout', status: 'pending' }]);
    expect(after).toContainEqual({ triggerEvent: 'stayover', status: 'skipped' });
  });

  it("a manager's rate re-states the stay's total: billed nights as billed, the rest at the new rate", async () => {
    const reservationId = await book(client, owner, branch, 'Rate Guest', today, lagosDay(3));
    await checkIn(client, owner, reservationId, branch.rooms[1].id);
    const override = await client.patch(`/reservations/${reservationId}/rate-override`, owner, { overrideRate: 15_000, reason: 'Long-standing guest' });
    expect(override.status).toBe(200);
    // Tonight was billed at check-in at 20,000; the other two nights at 15,000.
    expect(Number(override.body.confirmedRate)).toBe(50_000);
  });

  it("a late cancellation's first night is that night's own price, not the stay's average", async () => {
    const plan = await client.post(`/branches/${branch.id}/rate-plans`, owner, { name: 'Busy night', type: 'seasonal', amount: 50, adjustmentType: 'percentage', validFrom: today, validTo: today });
    expect(plan.status).toBe(201);
    const reservationId = await book(client, owner, branch, 'Late Canceller', today, lagosDay(2));
    // Tonight 30,000 (+50%), tomorrow 20,000: the average would be 25,000.
    const quote = await client.get(`/reservations/${reservationId}/cancellation-quote`, owner);
    expect(quote.body.penaltyAmount).toBe('30000.00');
    await client.patch(`/rate-plans/${plan.body.id}`, owner, { isActive: false });
  });

  it("taking an outlet's charge off the bill voids the order at the outlet too", async () => {
    const reservationId = await book(client, owner, branch, 'Diner', today, lagosDay(1));
    await checkIn(client, owner, reservationId, branch.rooms[2].id);
    const outlet = await client.post(`/branches/${branch.id}/pos/outlets`, owner, { name: 'Restaurant', category: 'restaurant' });
    const dish = await client.post(`/pos/outlets/${outlet.body.id}/menu-items`, owner, { name: 'Jollof', category: 'Mains', price: 5_000 });
    const order = await client.post('/pos/orders', owner, { outletId: outlet.body.id, settlement: 'room', reservationId, items: [{ menuItemId: dish.body.id, qty: 1 }] });
    expect(order.status).toBe(201);
    const line = await inTenant(prisma, owner.tenantId, (tx) => tx.posOrder.findFirstOrThrow({ where: { id: order.body.id as string }, select: { lineItemId: true } }));

    expect((await client.post(`/line-items/${line.lineItemId}/correct`, owner, { reason: 'Dish sent back' })).status).toBe(201);
    const after = await client.get(`/pos/orders/${order.body.id}`, owner);
    expect(after.body.voidedAt).not.toBeNull();
    expect((await client.post(`/pos/orders/${order.body.id}/void`, owner, { reason: 'Again' })).status).toBe(409);
  });

  it('a room two work orders took out of service stays out until both are done', async () => {
    const roomId = branch.rooms[5].id;
    const first = await client.post(`/branches/${branch.id}/maintenance/work-orders`, owner, { title: 'Leaking roof', roomId, priority: 'urgent', blockRoom: true });
    const second = await client.post(`/branches/${branch.id}/maintenance/work-orders`, owner, { title: 'Broken lock', roomId, priority: 'high', blockRoom: true });
    expect([first.status, second.status]).toEqual([201, 201]);
    const held = () => inTenant(prisma, owner.tenantId, (tx) => tx.room.findFirstOrThrow({ where: { id: roomId }, select: { heldStatus: true } }));

    expect((await client.patch(`/maintenance/work-orders/${first.body.id}`, owner, { status: 'resolved' })).status).toBe(200);
    expect((await held()).heldStatus).toBe('out_of_order');
    expect((await client.patch(`/maintenance/work-orders/${second.body.id}`, owner, { status: 'resolved' })).status).toBe(200);
    expect((await held()).heldStatus).toBeNull();
  });

  it('a guest who leaves early frees the nights they leave behind — occupancy counts the resold room once', async () => {
    const solo = await addBranch(client, owner, brandId, 'One Room', 1, 20_000);
    const early = await book(client, owner, solo, 'Early Leaver', today, lagosDay(3));
    await checkIn(client, owner, early, solo.rooms[0].id);
    await arrivedYesterday(early);
    expect((await client.post(`/reservations/${early}/check-out`, owner)).status).toBe(201);
    // The room goes straight back on sale and is taken for tonight and tomorrow.
    const next = await book(client, owner, solo, 'Next Guest', today, lagosDay(2));
    expect(next).toBeTruthy();

    const occupancy = await client.get(`/branches/${solo.id}/reports/occupancy?from=${yesterday}&to=${addDays(today, 2)}`, owner);
    expect(occupancy.status).toBe(200);
    expect(occupancy.body.trend.map((d: { roomNightsSold: number }) => d.roomNightsSold)).toEqual([1, 1, 1]);
    expect(occupancy.body.summary.occupancyPct).toBe(100);
  });
});
