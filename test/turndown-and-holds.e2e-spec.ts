import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { RoomsService } from '../src/modules/property/rooms.service';
import { addBranch, book, BranchLayout, checkIn, Client, deleteOrganisation, headBrand, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

type Task = { id: string; roomId: string; triggerEvent: string | null; status: string; taskDate: string };

/**
 * The evening turndown — raised for the rooms the branch turns down, never
 * moving a room along the cleaning ladder — and held rooms with a date they
 * come back into service.
 */
describe('Turndown and room release dates (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let branch: BranchLayout;

  const tasks = async () => (await client.get(`/branches/${branch.id}/housekeeping/tasks`, owner)).body as Task[];
  const room = async (roomId: string) =>
    ((await client.get(`/branches/${branch.id}/rooms`, owner)).body as Array<{ id: string; cleanlinessStatus: string; heldStatus: string | null; heldUntil: string | null }>).find(
      (r) => r.id === roomId,
    )!;
  const available = async (from: string, to: string) =>
    ((await client.get(`/branches/${branch.id}/availability?from=${from}&to=${to}&roomTypeId=${branch.roomTypeId}`, owner)).body as Array<{ available: number }>).map((n) => n.available);

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Turndown');
    branch = await addBranch(client, owner, await headBrand(client, owner), 'Turndown Branch', 6);
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it('turns down a checked-in guest’s room the same evening, leaving the room as clean as it was', async () => {
    expect((await client.patch(`/branches/${branch.id}/policies/turndown`, owner, { enabled: true })).status).toBe(400);
    expect((await client.patch(`/branches/${branch.id}/policies/turndown`, owner, { enabled: true, scope: 'all' })).status).toBe(200);
    const stay = await book(client, owner, branch, 'Evening Guest', lagosDay(0), lagosDay(2));
    await checkIn(client, owner, stay, branch.rooms[0].id);
    const before = (await room(branch.rooms[0].id)).cleanlinessStatus;

    const turndown = (await tasks()).find((t) => t.roomId === branch.rooms[0].id && t.triggerEvent === 'turndown');
    expect(turndown).toMatchObject({ status: 'pending', taskDate: expect.stringContaining(lagosDay(0)) });
    expect((await client.post(`/housekeeping/tasks/${turndown!.id}/start`, owner, {})).status).toBe(201);
    expect((await client.post(`/housekeeping/tasks/${turndown!.id}/complete`, owner, {})).status).toBe(201);
    expect((await room(branch.rooms[0].id)).cleanlinessStatus).toBe(before);

    // A clean asked for while a turndown waits is a different job — both stand.
    const second = await book(client, owner, branch, 'Second Guest', lagosDay(0), lagosDay(1));
    await checkIn(client, owner, second, branch.rooms[1].id);
    expect((await client.post(`/branches/${branch.id}/housekeeping/tasks`, owner, { roomId: branch.rooms[1].id, notes: 'Spill' })).status).toBe(201);
    expect((await client.post(`/branches/${branch.id}/housekeeping/tasks`, owner, { roomId: branch.rooms[1].id, kind: 'turndown' })).status).toBe(409);

    // Checking out takes the waiting turndown with the guest.
    expect((await client.post(`/reservations/${second}/check-out`, owner, {})).status).toBe(201);
    const left = (await tasks()).find((t) => t.roomId === branch.rooms[1].id && t.triggerEvent === 'turndown');
    expect(left?.status).toBe('skipped');
  });

  it('turns down only VIP guests’ rooms when the branch says so', async () => {
    expect((await client.patch(`/branches/${branch.id}/policies/turndown`, owner, { enabled: true, scope: 'vip' })).status).toBe(200);
    const plain = await book(client, owner, branch, 'Plain Guest', lagosDay(0), lagosDay(2));
    await checkIn(client, owner, plain, branch.rooms[2].id);
    expect((await tasks()).some((t) => t.roomId === branch.rooms[2].id && t.triggerEvent === 'turndown')).toBe(false);

    const vip = await book(client, owner, branch, 'Vip Guest', lagosDay(0), lagosDay(2));
    const guestId = await inTenant(prisma, owner.tenantId, async (tx) => (await tx.reservation.findFirstOrThrow({ where: { id: vip } })).guestId);
    await inTenant(prisma, owner.tenantId, (tx) => tx.guestProfile.update({ where: { id: guestId }, data: { vipLevel: 2 } }));
    await checkIn(client, owner, vip, branch.rooms[3].id);
    expect((await tasks()).some((t) => t.roomId === branch.rooms[3].id && t.triggerEvent === 'turndown')).toBe(true);
    expect((await client.patch(`/branches/${branch.id}/policies/turndown`, owner, { enabled: false })).status).toBe(200);
  });

  it('a room held until a date is sold again from that night, and comes back on its own that day', async () => {
    const heldRoom = branch.rooms[5].id;
    const before = await available(lagosDay(10), lagosDay(14));
    expect((await client.patch(`/rooms/${heldRoom}/status`, owner, { heldStatus: 'out_of_order', heldUntil: lagosDay(0) })).status).toBe(400);
    expect((await client.patch(`/rooms/${heldRoom}/status`, owner, { heldStatus: 'out_of_order', heldUntil: lagosDay(12) })).status).toBe(200);
    expect((await room(heldRoom)).heldUntil).toContain(lagosDay(12));
    // Out for the 10th and 11th, back from the 12th.
    expect(await available(lagosDay(10), lagosDay(14))).toEqual([before[0] - 1, before[1] - 1, before[2], before[3]]);

    // Releasing by hand clears the date with the hold.
    expect((await client.patch(`/rooms/${heldRoom}/status`, owner, { heldStatus: null })).status).toBe(200);
    expect(await room(heldRoom)).toMatchObject({ heldStatus: null, heldUntil: null });
    expect((await client.patch(`/rooms/${heldRoom}/status`, owner, { heldUntil: lagosDay(5) })).status).toBe(400);

    // Due back today: the sweep puts it back in service.
    expect((await client.patch(`/rooms/${heldRoom}/status`, owner, { heldStatus: 'blocked', heldUntil: lagosDay(3) })).status).toBe(200);
    await inTenant(prisma, owner.tenantId, (tx) => tx.room.update({ where: { id: heldRoom }, data: { heldUntil: new Date(`${lagosDay(0)}T00:00:00.000Z`) } }));
    expect(await app.get(RoomsService).releaseDueHolds()).toBeGreaterThanOrEqual(1);
    expect(await room(heldRoom)).toMatchObject({ heldStatus: null, heldUntil: null });
  });
});
