import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, book, BranchLayout, checkIn, Client, deleteOrganisation, headBrand, hire, inParallel, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * The night audit at a busy branch — third audit, H1.
 *
 * It used to close the whole branch in one transaction under Prisma's
 * five-second limit: 300 in-house stays came back as a 500 after 5 s, the
 * run's own record rolled back with everything else, and the hourly sweep
 * retried the same failure for ever. It now records the run first and closes
 * stays in batches of 25, each its own transaction.
 *
 * Also guards a bug the third audit's fixes surfaced: the stay-over task the
 * audit raises for each occupied room could never be started, because the
 * room was still marked clean and cleaning only starts from dirty.
 */
describe('Night audit at a busy branch (e2e)', () => {
  const STAYS = 300;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let branch: BranchLayout;
  const yesterday = lagosDay(-1);

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Night Audit');
    branch = await addBranch(client, owner, await headBrand(client, owner), 'Busy Branch', STAYS);
    // Booked and checked in today, then moved to have arrived yesterday:
    // checking in a stay that arrived yesterday bills that night at check-in,
    // which would leave the audit nothing to post.
    // One at a time, as a front desk would: many interactive transactions at
    // once from one process is not what this suite is about.
    await inParallel(branch.rooms, 1, async (room, i) => {
      const reservationId = await book(client, owner, branch, `Stay Guest ${i}`, lagosDay(0), lagosDay(2));
      await checkIn(client, owner, reservationId, room.id);
    });
    const moved = await inTenant(prisma, owner.tenantId, (tx) =>
      tx.reservation.updateMany({
        where: { branchId: branch.id, status: 'checked_in' },
        data: {
          checkInDate: new Date(`${yesterday}T00:00:00.000Z`),
          checkOutDate: new Date(`${lagosDay(1)}T00:00:00.000Z`),
          actualCheckIn: new Date(`${yesterday}T14:00:00.000Z`),
        },
      }),
    );
    expect(moved.count).toBe(STAYS);
  }, 600_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it('closes 300 in-house stays in one run, and a run started meanwhile is told one is running', async () => {
    const before = await client.get(`/branches/${branch.id}/night-audit/preflight`, owner);
    expect(before.body.pendingDates).toEqual([yesterday]);

    const runs = await Promise.all([
      client.post(`/branches/${branch.id}/night-audit/run`, owner, { auditDate: yesterday }),
      new Promise((resolve) => setTimeout(resolve, 150)).then(() => client.post(`/branches/${branch.id}/night-audit/run`, owner, { auditDate: yesterday })),
    ]);
    const closed = runs.find((r) => r.status === 201);
    const refused = runs.find((r) => r !== closed);
    expect(closed?.body).toMatchObject({ status: 'completed', foliosProcessed: STAYS, chargesPosted: STAYS, errors: [] });
    expect(refused?.status).toBe(409);
    expect(refused?.body.detail).toMatch(/running now/);

    const logs = await inTenant(prisma, owner.tenantId, (tx) => tx.nightAuditLog.findMany({ where: { branchId: branch.id } }));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 'completed', chargesPosted: STAYS });
    const roomCharges = await inTenant(prisma, owner.tenantId, (tx) =>
      tx.lineItem.count({ where: { folio: { branchId: branch.id }, chargeType: 'room', serviceDate: new Date(`${yesterday}T00:00:00.000Z`), isVoid: false } }),
    );
    expect(roomCharges).toBe(STAYS);

    const after = await client.get(`/branches/${branch.id}/night-audit/preflight`, owner);
    expect(after.body.pendingDates).toEqual([]);
    expect(after.body.lastStoppedRun).toBeNull();
  });

  it('refuses to close the same night twice', async () => {
    const again = await client.post(`/branches/${branch.id}/night-audit/run`, owner, { auditDate: yesterday });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('AUDIT_ALREADY_RAN');
  });

  it('raises a stay-over task for every occupied room, and a housekeeper can start one', async () => {
    const tasks = await client.get(`/branches/${branch.id}/housekeeping/tasks?status=pending`, owner);
    const stayovers = (tasks.body as Array<{ id: string; roomId: string; triggerEvent: string }>).filter((t) => t.triggerEvent === 'stayover');
    expect(stayovers).toHaveLength(STAYS);

    const housekeeper = await hire(client, owner, branch.id, 'housekeeper', 'night-hk');
    const started = await client.post(`/housekeeping/tasks/${stayovers[0].id}/start`, housekeeper);
    expect(started.status).toBe(201);
    const room = await inTenant(prisma, owner.tenantId, (tx) => tx.room.findFirst({ where: { id: stayovers[0].roomId }, select: { cleanlinessStatus: true } }));
    expect(room?.cleanlinessStatus).toBe('cleaning');
  });
});
