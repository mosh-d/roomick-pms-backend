import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { LoyaltyService } from '../src/modules/loyalty/loyalty.service';
import { addBranch, book, BranchLayout, checkIn, Client, deleteOrganisation, headBrand, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

type GuestLoyalty = { balance: number; lifetimePoints: number; expiring: { points: number; on: string } | null; transactions: Array<{ type: string; points: number }> };

/** Points that lapse unspent: spending comes off the soonest-lapsing first, and the nightly sweep takes off what's left of them. */
describe('Loyalty points expiry (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let branch: BranchLayout;

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Loyalty Expiry');
    branch = await addBranch(client, owner, await headBrand(client, owner), 'Loyalty Branch', 2);
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it('earns points that lapse months later, spends the soonest-lapsing first, and takes off the rest once they lapse', async () => {
    const saved = await client.put('/loyalty/program', owner, {
      isActive: true,
      currency: 'NGN',
      pointsPerUnit: 0.01,
      pointValue: 10,
      tiers: [{ name: 'Member', threshold: 0, benefits: [] }],
      pointsExpireAfterMonths: 12,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.pointsExpireAfterMonths).toBe(12);

    const stay = await book(client, owner, branch, 'Loyal Guest', lagosDay(0), lagosDay(1));
    await checkIn(client, owner, stay, branch.rooms[0].id);
    expect((await client.post(`/reservations/${stay}/check-out`, owner, {})).status).toBe(201);
    const guestId = await inTenant(prisma, owner.tenantId, async (tx) => (await tx.reservation.findFirstOrThrow({ where: { id: stay } })).guestId);
    const loyalty = async () => (await client.get(`/guests/${guestId}/loyalty`, owner)).body as GuestLoyalty;

    const earned = await loyalty();
    expect(earned.balance).toBe(200);
    expect(earned.expiring?.points).toBe(200);
    expect(earned.expiring?.on.slice(0, 4)).toBe(String(Number(lagosDay(0).slice(0, 4)) + 1));

    // 50 taken off come out of the points due to lapse.
    expect((await client.post(`/guests/${guestId}/loyalty/adjustments`, owner, { points: -50, reason: 'Correction' })).status).toBe(201);
    expect((await loyalty()).expiring?.points).toBe(150);

    // A year on: the 150 lapse, once.
    await inTenant(prisma, owner.tenantId, (tx) => tx.loyaltyTransaction.updateMany({ where: { guestId, type: 'earn' }, data: { expiresAt: new Date(Date.now() - 60_000) } }));
    const sweep = app.get(LoyaltyService);
    expect(await sweep.expireLapsedPoints()).toBeGreaterThanOrEqual(150);
    const after = await loyalty();
    expect(after).toMatchObject({ balance: 0, lifetimePoints: 200, expiring: null });
    expect(after.transactions.find((t) => t.type === 'expire')?.points).toBe(-150);
    await sweep.expireLapsedPoints();
    expect((await loyalty()).transactions.filter((t) => t.type === 'expire')).toHaveLength(1);
  });
});
