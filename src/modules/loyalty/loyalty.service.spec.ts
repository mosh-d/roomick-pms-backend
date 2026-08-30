import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { LoyaltyService } from './loyalty.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('LoyaltyService', () => {
  let service: LoyaltyService;
  let tx: { guestProfile: { findMany: jest.Mock } };
  let prisma: { withTenant: jest.Mock };

  beforeEach(async () => {
    tx = { guestProfile: { findMany: jest.fn().mockResolvedValue([]) } };
    prisma = { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) };
    const moduleRef = await Test.createTestingModule({
      providers: [LoyaltyService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(LoyaltyService);
  });

  it('only queries guests with a tier set or points above zero, excluding soft-deleted ones', async () => {
    await service.getSummary(TENANT_ID);
    expect(tx.guestProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, OR: [{ loyaltyTier: { not: null } }, { loyaltyPoints: { gt: 0 } }] },
      }),
    );
  });

  it('defaults a null tier to "Untiered" and null points to 0', async () => {
    tx.guestProfile.findMany.mockResolvedValue([{ id: 'g1', name: 'Anon', email: null, loyaltyTier: null, loyaltyPoints: 150 }]);
    const result = await service.getSummary(TENANT_ID);
    expect(result.members[0]).toEqual({ id: 'g1', name: 'Anon', email: null, loyaltyTier: 'Untiered', loyaltyPoints: 150 });
  });

  it('groups members by tier with correct per-tier member counts and point totals', async () => {
    tx.guestProfile.findMany.mockResolvedValue([
      { id: 'g1', name: 'Gold A', email: 'a@x.com', loyaltyTier: 'Gold', loyaltyPoints: 500 },
      { id: 'g2', name: 'Gold B', email: 'b@x.com', loyaltyTier: 'Gold', loyaltyPoints: 300 },
      { id: 'g3', name: 'Silver A', email: 'c@x.com', loyaltyTier: 'Silver', loyaltyPoints: 100 },
    ]);
    const result = await service.getSummary(TENANT_ID);
    const gold = result.byTier.find((t) => t.tier === 'Gold');
    const silver = result.byTier.find((t) => t.tier === 'Silver');
    expect(gold).toEqual({ tier: 'Gold', memberCount: 2, totalPoints: 800 });
    expect(silver).toEqual({ tier: 'Silver', memberCount: 1, totalPoints: 100 });
  });

  it('computes totalMembers and totalPointsIssued across every tier', async () => {
    tx.guestProfile.findMany.mockResolvedValue([
      { id: 'g1', name: 'A', email: null, loyaltyTier: 'Gold', loyaltyPoints: 500 },
      { id: 'g2', name: 'B', email: null, loyaltyTier: 'Silver', loyaltyPoints: 100 },
    ]);
    const result = await service.getSummary(TENANT_ID);
    expect(result.totalMembers).toBe(2);
    expect(result.totalPointsIssued).toBe(600);
  });

  it('returns an empty, well-shaped summary when no guest has any loyalty data', async () => {
    const result = await service.getSummary(TENANT_ID);
    expect(result).toEqual({ members: [], byTier: [], totalMembers: 0, totalPointsIssued: 0 });
  });
});
