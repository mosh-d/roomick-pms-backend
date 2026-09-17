import { Prisma } from '@prisma/client';
import { SUGGESTED_TIERS, nextTierFor, pointsForSpend, redemptionValue, tierFor } from './loyalty-rules';

describe('loyalty rules', () => {
  it('a member holds the highest tier their lifetime points reach', () => {
    expect(tierFor(SUGGESTED_TIERS, 0)?.name).toBe('Member');
    expect(tierFor(SUGGESTED_TIERS, 1499)?.name).toBe('Silver');
    expect(tierFor(SUGGESTED_TIERS, 1500)?.name).toBe('Gold');
    expect(tierFor(SUGGESTED_TIERS, 999_999)?.name).toBe('Platinum');
    expect(tierFor([], 5000)).toBeNull();
  });

  it('works out the tiers in threshold order, however they were entered', () => {
    const shuffled = [SUGGESTED_TIERS[3], SUGGESTED_TIERS[1], SUGGESTED_TIERS[0], SUGGESTED_TIERS[2]];
    expect(tierFor(shuffled, 600)?.name).toBe('Silver');
  });

  it('says how far the next tier is, and nothing past the top', () => {
    expect(nextTierFor(SUGGESTED_TIERS, 600)).toEqual({ name: 'Gold', pointsToGo: 900 });
    expect(nextTierFor(SUGGESTED_TIERS, 5000)).toBeNull();
  });

  it('earns whole points on spend before tax, rounded down', () => {
    expect(pointsForSpend(new Prisma.Decimal('32250'), new Prisma.Decimal('0.01'))).toBe(322);
    expect(pointsForSpend(new Prisma.Decimal('99.99'), new Prisma.Decimal('0.01'))).toBe(0);
    expect(pointsForSpend(new Prisma.Decimal('-5000'), new Prisma.Decimal('0.01'))).toBe(0);
  });

  it('values redeemed points down to the cent, never up', () => {
    expect(redemptionValue(1234, new Prisma.Decimal('0.3333')).toFixed(2)).toBe('411.29');
    expect(redemptionValue(3, new Prisma.Decimal('0.001')).toFixed(2)).toBe('0.00');
    expect(redemptionValue(500, new Prisma.Decimal('1')).toFixed(2)).toBe('500.00');
  });
});
