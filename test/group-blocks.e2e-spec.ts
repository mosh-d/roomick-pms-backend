import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, addDays, BranchLayout, Client, deleteOrganisation, headBrand, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * Group blocks — the second audit's date window and the third audit's M7.
 *
 * A booking at the block's rate could be made for any dates at all. And
 * changing a group stay's dates re-priced it at the public rate (while the
 * bill kept posting the block rate) and let it leave the block's dates.
 */
describe('Group blocks (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let branch: BranchLayout;
  let deluxeId: string;
  let blockId: string;
  const arrival = lagosDay(30);
  const departure = addDays(arrival, 3);

  const bookInto = (checkInDate?: string, checkOutDate?: string) =>
    client.post(`/group-blocks/${blockId}/reservations`, owner, {
      guest: { name: `Wedding Guest ${Math.random().toString(36).slice(2, 6)}`, email: `wedding.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@example.com` },
      adults: 1,
      ...(checkInDate ? { checkInDate, checkOutDate } : {}),
    });
  const stay = (id: string) => inTenant(prisma, owner.tenantId, (tx) => tx.reservation.findFirst({ where: { id }, select: { confirmedRate: true, overrideRate: true } }));

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Group Blocks');
    branch = await addBranch(client, owner, await headBrand(client, owner), 'Group Branch', 8, 20_000);
    deluxeId = (await client.post(`/branches/${branch.id}/room-types`, owner, { name: 'Deluxe', baseRate: 30_000, capacity: { adults: 2, children: 1 } })).body.id as string;
    const block = await client.post(`/branches/${branch.id}/group-blocks`, owner, {
      name: 'Wedding',
      roomTypeId: branch.roomTypeId,
      blockSize: 5,
      blockRate: 12_000,
      arrivalDate: arrival,
      departureDate: departure,
      cutoffDate: addDays(arrival, -5),
    });
    expect(block.status).toBe(201);
    blockId = block.body.id as string;
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it("books the block's own nights at its rate, give or take two shoulder nights — and nothing further", async () => {
    const inside = await bookInto();
    expect(inside.status).toBe(201);
    expect(await stay(inside.body.reservationId as string)).toMatchObject({ overrideRate: expect.anything() });
    expect(Number((await stay(inside.body.reservationId as string))?.confirmedRate)).toBe(36_000);
    expect((await bookInto(addDays(arrival, -2), departure)).status).toBe(201);
    expect((await bookInto(addDays(arrival, -3), departure)).status).toBe(400);
    expect((await bookInto(lagosDay(80), lagosDay(82))).status).toBe(400);
  });

  it('refuses a block at a rate of zero', async () => {
    const free = await client.post(`/branches/${branch.id}/group-blocks`, owner, {
      name: 'Free block',
      roomTypeId: branch.roomTypeId,
      blockSize: 1,
      blockRate: 0,
      arrivalDate: arrival,
      departureDate: departure,
      cutoffDate: addDays(arrival, -5),
    });
    expect(free.status).toBe(400);
  });

  it("re-dating a group stay keeps the block's rate, not the public one (was re-priced at 20,000 a night)", async () => {
    const booked = await bookInto();
    const id = booked.body.reservationId as string;
    const moved = await client.patch(`/reservations/${id}/modify`, owner, { checkInDate: addDays(arrival, 1), checkOutDate: departure, reason: 'Arriving a day later' });
    expect(moved.status).toBe(200);
    expect(Number((await stay(id))?.confirmedRate)).toBe(24_000);
  });

  it("a group stay can't leave its block's dates or room type, and may take the shoulder nights", async () => {
    const id = (await bookInto()).body.reservationId as string;
    const away = await client.patch(`/reservations/${id}/modify`, owner, { checkInDate: addDays(arrival, -10), checkOutDate: addDays(arrival, -8), reason: 'Moved' });
    expect(away.status).toBe(400);
    expect(away.body.detail).toMatch(/block's nights/);
    const upgrade = await client.patch(`/reservations/${id}/modify`, owner, { roomTypeId: deluxeId, reason: 'Upgrade' });
    expect(upgrade.status).toBe(400);
    expect((await client.patch(`/reservations/${id}/modify`, owner, { checkInDate: addDays(arrival, -2), checkOutDate: addDays(arrival, 1), reason: 'Early arrival' })).status).toBe(200);
  });
});
