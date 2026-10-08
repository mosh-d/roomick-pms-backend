import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, book, BranchLayout, Client, deleteOrganisation, headBrand, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * Selling rooms, and the rules around it — from the second audit's live repros.
 *
 * A walk-in could take a room already promised to tonight's arrivals; a
 * stop-sell didn't stop walk-ins; restrictions took impossible rules; a
 * work order at one branch could take another branch's room out of order;
 * a booking could be marked a no-show weeks before its arrival; a guest's
 * name could run as a formula in an exported CSV; and a suspended
 * organisation's staff could still sign in.
 */
describe('Selling rooms (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let a: BranchLayout;
  let c: BranchLayout;
  const today = lagosDay(0);

  const walkIn = (branch: BranchLayout, roomIndex: number, name: string) =>
    client.post(`/branches/${branch.id}/reservations/walk-in`, owner, {
      guest: { name, email: `${name.toLowerCase().replace(/\s+/g, '.')}.${Date.now()}@example.com` },
      roomTypeId: branch.roomTypeId,
      roomId: branch.rooms[roomIndex].id,
      checkOutDate: lagosDay(1),
      adults: 1,
    });

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Selling Rooms');
    const brandId = await headBrand(client, owner);
    a = await addBranch(client, owner, brandId, 'Branch A', 2);
    c = await addBranch(client, owner, brandId, 'Branch C', 2);
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it("won't sell a walk-in a room every one of which is promised to tonight's arrivals", async () => {
    await book(client, owner, a, 'Arrival One', today, lagosDay(2));
    await book(client, owner, a, 'Arrival Two', today, lagosDay(2));
    const walk = await walkIn(a, 0, 'Walk In');
    expect(walk.status).toBe(409);
    expect(walk.body.code).toBe('RESERVATION_NOT_AVAILABLE');
  });

  it('a stop-sell stops walk-ins too', async () => {
    expect((await walkIn(c, 0, 'Walk Ok')).status).toBe(201);
    expect((await client.post(`/branches/${c.id}/availability-restrictions`, owner, { startDate: today, endDate: lagosDay(1), stopSell: true })).status).toBe(201);
    const stopped = await walkIn(c, 1, 'Walk Stop');
    expect(stopped.status).toBe(409);
    expect(stopped.body.detail).toMatch(/stop-sell/);
  });

  it.each([
    ['ends before it starts', () => ({ startDate: lagosDay(60), endDate: lagosDay(50), stopSell: true }), 400],
    ['has a minimum stay longer than its maximum', () => ({ startDate: lagosDay(50), endDate: lagosDay(60), minLOS: 5, maxLOS: 2 }), 400],
    ['has no rule at all', () => ({ startDate: lagosDay(50), endDate: lagosDay(60) }), 400],
    ["names another branch's room type", () => ({ startDate: lagosDay(50), endDate: lagosDay(60), roomTypeId: a.roomTypeId, stopSell: true }), 404],
    ['repeats a live stop-sell', () => ({ startDate: today, endDate: lagosDay(1), stopSell: true }), 409],
  ])('refuses a restriction that %s', async (_label, body, status) => {
    expect((await client.post(`/branches/${c.id}/availability-restrictions`, owner, body())).status).toBe(status);
  });

  it("won't let a work order at one branch take another branch's room out of order", async () => {
    const crossed = await client.post(`/branches/${a.id}/maintenance/work-orders`, owner, { title: 'Broken AC', roomId: c.rooms[1].id, blockRoom: true });
    expect(crossed.status).toBe(404);
    const room = await inTenant(prisma, owner.tenantId, (tx) => tx.room.findFirst({ where: { id: c.rooms[1].id } }));
    expect(room?.heldStatus ?? null).toBeNull();
  });

  it("won't mark a booking a no-show before its arrival day", async () => {
    const later = await book(client, owner, a, 'Future Guest', lagosDay(30), lagosDay(31));
    const early = await client.post(`/reservations/${later}/no-show`, owner);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it("exports a guest's name as text, never as a spreadsheet formula", async () => {
    await book(client, owner, a, '=HYPERLINK("http://evil.example/x","Open me")', lagosDay(40), lagosDay(41));
    const csv = await client.post(`/branches/${a.id}/reports/custom/csv`, owner, { dataset: 'guests', fields: ['name'], from: lagosDay(-1), to: lagosDay(1) });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil.example/x"",""Open me"")"`);
  });

  it('forecasts demand for a branch opened today (was a 400 on its own first day)', async () => {
    const forecast = await client.get(`/branches/${c.id}/demand-forecast?horizonDays=30`, owner);
    expect(forecast.status).toBe(200);
    expect(forecast.body).toHaveLength(30);
    expect((await client.get(`/branches/${c.id}/demand-forecast?horizonDays=5000`, owner)).status).toBe(400);
  });

  it("refuses a suspended organisation's sign-ins and renewals", async () => {
    const status = (await prisma.tenant.findUniqueOrThrow({ where: { id: owner.tenantId } })).status;
    const fresh = await client.post('/auth/login', null, { email: owner.email, password: owner.password });
    await prisma.tenant.update({ where: { id: owner.tenantId }, data: { status: 'suspended' } });
    try {
      const login = await client.post('/auth/login', null, { email: owner.email, password: owner.password });
      expect(login.status).toBe(403);
      expect(login.body.code).toBe('TENANT_SUSPENDED');
      const renew = await client.post('/auth/refresh', null, { refreshToken: fresh.body.refreshToken });
      expect(renew.status).toBe(403);
    } finally {
      await prisma.tenant.update({ where: { id: owner.tenantId }, data: { status } });
    }
  });
});
