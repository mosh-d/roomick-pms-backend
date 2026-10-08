import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, book, BranchLayout, checkIn, Client, deleteOrganisation, headBrand, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * Taking rooms out of order — third audit, H2 and M6.
 *
 * "End Block" on a block that hadn't started set its end before its start,
 * which the database refuses: a 500, and no way to remove a block entered by
 * mistake. And a room could be blocked with a guest asleep in it, or blocked
 * twice for the same nights.
 */
describe('Room blocks (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let branch: BranchLayout;
  const today = lagosDay(0);

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Room Blocks');
    branch = await addBranch(client, owner, await headBrand(client, owner), 'Block Branch', 6);
    // Room 101 has a guest in it until the day after tomorrow.
    await checkIn(client, owner, await book(client, owner, branch, 'Sleeping Guest', today, lagosDay(2)), branch.rooms[0].id);
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  const block = (roomIndex: number, fromDate: string, toDate: string) =>
    client.post(`/rooms/${branch.rooms[roomIndex].id}/block`, owner, { reason: 'maintenance', fromDate, toDate });

  it('cancels a block that has not started — it is removed, and the trail says so (was a 500)', async () => {
    const future = await block(5, lagosDay(5), lagosDay(7));
    expect(future.status).toBe(201);
    const listed = await client.get(`/branches/${branch.id}/room-blocks`, owner);
    expect((listed.body as Array<{ id: string }>).some((b) => b.id === future.body.id)).toBe(true);

    const cancelled = await client.post(`/room-blocks/${future.body.id}/end`, owner);
    expect(cancelled.status).toBe(201);
    const row = await inTenant(prisma, owner.tenantId, (tx) => tx.roomBlock.findFirst({ where: { id: future.body.id as string } }));
    expect(row).toBeNull();
    const trail = await inTenant(prisma, owner.tenantId, (tx) => tx.auditLog.findFirst({ where: { entityId: future.body.id as string, action: 'room.block_cancelled' } }));
    expect(trail).toMatchObject({ branchId: branch.id, userId: owner.userId });
  });

  it('ends a block already under way at last night, and refuses to end it twice', async () => {
    const running = await block(4, today, lagosDay(3));
    expect(running.status).toBe(201);
    // Began two days ago — the API takes no back-dated block, so the start is moved in the database.
    await inTenant(prisma, owner.tenantId, (tx) => tx.roomBlock.update({ where: { id: running.body.id as string }, data: { fromDate: new Date(`${lagosDay(-2)}T00:00:00.000Z`) } }));

    const ended = await client.post(`/room-blocks/${running.body.id}/end`, owner);
    expect(ended.status).toBe(201);
    const row = await inTenant(prisma, owner.tenantId, (tx) => tx.roomBlock.findFirst({ where: { id: running.body.id as string } }));
    expect(row?.toDate.toISOString().slice(0, 10)).toBe(lagosDay(-1));

    const again = await client.post(`/room-blocks/${running.body.id}/end`, owner);
    expect(again.status).toBe(409);
  });

  it('refuses a block over a room with a guest in it, and takes one from the day they leave', async () => {
    const occupied = await block(0, today, lagosDay(2));
    expect(occupied.status).toBe(409);
    expect(occupied.body.detail).toMatch(/Sleeping Guest/);
    expect((await block(0, lagosDay(2), lagosDay(4))).status).toBe(201);
  });

  it('refuses the same nights twice, or overlapping ones, and takes the next free nights', async () => {
    expect((await block(3, today, lagosDay(2))).status).toBe(201);
    const twice = await block(3, today, lagosDay(2));
    expect(twice.status).toBe(409);
    expect(twice.body.detail).toMatch(/already blocked/);
    expect((await block(3, lagosDay(1), lagosDay(3))).status).toBe(409);
    expect((await block(3, lagosDay(3), lagosDay(4))).status).toBe(201);
  });
});
