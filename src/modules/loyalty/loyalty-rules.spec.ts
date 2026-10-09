import { Prisma } from '@prisma/client';
import { LedgerRow, SUGGESTED_TIERS, lapsedPoints, nextTierFor, pointsExpireAt, pointsForSpend, redemptionValue, tierFor } from './loyalty-rules';

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

  describe('points expiry', () => {
    const at = (day: string) => new Date(`${day}T12:00:00.000Z`);
    const earn = (points: number, lapses: string | null): LedgerRow => ({ type: 'earn', points, expiresAt: lapses ? at(lapses) : null });

    it('lapse the same day of the month, months later — the month’s last day when it’s shorter', () => {
      expect(pointsExpireAt(at('2026-01-15'), 12)?.toISOString().slice(0, 10)).toBe('2027-01-15');
      expect(pointsExpireAt(at('2026-01-31'), 1)?.toISOString().slice(0, 10)).toBe('2026-02-28');
      expect(pointsExpireAt(at('2026-01-31'), null)).toBeNull();
    });

    it('spending comes off the soonest-lapsing earnings first', () => {
      const rows = [earn(100, '2026-06-01'), earn(200, '2027-06-01'), { type: 'redeem' as const, points: -80, expiresAt: null }];
      // 80 spent from the first 100: 20 of it lapses on 1 June.
      expect(lapsedPoints(rows, at('2026-06-02'))).toEqual({ due: 20, next: { points: 200, on: at('2027-06-01') } });
      expect(lapsedPoints(rows, at('2026-05-01')).next).toEqual({ points: 20, on: at('2026-06-01') });
    });

    it('nothing lapses twice, and points given back count again', () => {
      const lapsed = [earn(100, '2026-06-01'), { type: 'expire' as const, points: -100, expiresAt: null }];
      expect(lapsedPoints(lapsed, at('2026-07-01')).due).toBe(0);
      const voided = [earn(100, '2026-06-01'), { type: 'redeem' as const, points: -60, expiresAt: null }, { type: 'reversal' as const, points: 60, expiresAt: null }];
      expect(lapsedPoints(voided, at('2026-07-01')).due).toBe(100);
    });

    it('points that never lapse are spent last, and never lapse themselves', () => {
      const rows = [earn(100, null), { type: 'adjust' as const, points: 50, expiresAt: null }, earn(40, '2026-06-01'), { type: 'adjust' as const, points: -30, expiresAt: null }];
      expect(lapsedPoints(rows, at('2026-07-01'))).toEqual({ due: 10, next: null });
    });
  });
});
