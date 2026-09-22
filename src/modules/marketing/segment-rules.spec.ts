import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MARKETING_CONSENT_FLOOR,
  describeCriteria,
  guestWhereFor,
  matchesAggregates,
  needsAggregates,
  parseCriteria,
} from './segment-rules';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

describe('segment-rules', () => {
  describe('parseCriteria', () => {
    it('accepts an empty object — "everyone who has opted in" is a real audience', () => {
      expect(parseCriteria({})).toEqual({});
    });

    it('refuses an unknown rule instead of dropping it, because dropping one would widen the audience', () => {
      expect(() => parseCriteria({ minStays: 2, spendOver: 100 })).toThrow(BadRequestException);
    });

    it('refuses negative numbers and non-list lists', () => {
      expect(() => parseCriteria({ minStays: -1 })).toThrow(BadRequestException);
      expect(() => parseCriteria({ tags: 'vip' })).toThrow(BadRequestException);
      expect(() => parseCriteria({ tags: ['vip', ''] })).toThrow(BadRequestException);
    });

    it('trims list values and drops empty lists', () => {
      expect(parseCriteria({ tags: [' vip '], loyaltyTiers: [] })).toEqual({ tags: ['vip'] });
    });

    it('refuses two recency rules that no guest could satisfy together', () => {
      expect(() => parseCriteria({ lastStayWithinDays: 90, notStayedForDays: 30 })).toThrow(/No guest can both/);
      expect(parseCriteria({ lastStayWithinDays: 30, notStayedForDays: 90 })).toEqual({ lastStayWithinDays: 30, notStayedForDays: 90 });
    });

    it('refuses a VIP level above 5', () => {
      expect(() => parseCriteria({ vipLevelMin: 6 })).toThrow(/0 to 5/);
    });

    it('refuses something that is not an object at all', () => {
      expect(() => parseCriteria(null)).toThrow(BadRequestException);
      expect(() => parseCriteria([1, 2])).toThrow(BadRequestException);
    });
  });

  describe('guestWhereFor', () => {
    it('never includes the consent floor itself — that is applied by the sender, not the saved rules', () => {
      const where = guestWhereFor({}, NOW);
      expect(where).toEqual({ deletedAt: null });
      expect(MARKETING_CONSENT_FLOOR).toEqual({ marketingOptIn: true, email: { not: null } });
    });

    it('keeps every stay-history rule — they AND together instead of overwriting one another', () => {
      const where = guestWhereFor({ branchIds: ['b1'], lastStayWithinDays: 365, notStayedForDays: 30 }, NOW);
      expect(where.AND).toHaveLength(3);
      expect(where.AND).toEqual([
        { reservations: { some: { status: 'checked_out', deletedAt: null, branchId: { in: ['b1'] } } } },
        { reservations: { some: { status: 'checked_out', deletedAt: null, checkOutDate: { gte: daysAgo(365) } } } },
        { reservations: { none: { status: 'checked_out', deletedAt: null, checkOutDate: { gte: daysAgo(30) } } } },
      ]);
    });

    it('maps the guest-level rules onto the profile', () => {
      const where = guestWhereFor({ vipLevelMin: 3, loyaltyTiers: ['Gold'], tags: ['corporate'], nationalities: ['NG'] }, NOW);
      expect(where).toMatchObject({
        vipLevel: { gte: 3 },
        loyaltyTier: { in: ['Gold'] },
        tags: { hasSome: ['corporate'] },
        nationality: { in: ['NG'] },
      });
    });
  });

  describe('needsAggregates', () => {
    it('is only true for the two rules the database cannot filter on', () => {
      expect(needsAggregates({ notStayedForDays: 180, vipLevelMin: 2 })).toBe(false);
      expect(needsAggregates({ minStays: 2 })).toBe(true);
      expect(needsAggregates({ minTotalSpend: 100_000 })).toBe(true);
    });
  });

  describe('matchesAggregates', () => {
    const guest = (stays: number, spend: string, lastStayAt: Date | null) => ({ stays, totalSpend: new Prisma.Decimal(spend), lastStayAt });

    it('checks the stay count and lifetime spend as minimums', () => {
      expect(matchesAggregates(guest(3, '150000', daysAgo(10)), { minStays: 3, minTotalSpend: 150_000 }, NOW)).toBe(true);
      expect(matchesAggregates(guest(2, '150000', daysAgo(10)), { minStays: 3 }, NOW)).toBe(false);
      expect(matchesAggregates(guest(3, '149999.99', daysAgo(10)), { minTotalSpend: 150_000 }, NOW)).toBe(false);
    });

    it('does not treat a guest who never stayed as a recent guest', () => {
      expect(matchesAggregates(guest(0, '0', null), { lastStayWithinDays: 90 }, NOW)).toBe(false);
    });

    it('does treat a guest who never stayed as lapsed — a real win-back target', () => {
      expect(matchesAggregates(guest(0, '0', null), { notStayedForDays: 180 }, NOW)).toBe(true);
      expect(matchesAggregates(guest(1, '0', daysAgo(200)), { notStayedForDays: 180 }, NOW)).toBe(true);
      expect(matchesAggregates(guest(1, '0', daysAgo(100)), { notStayedForDays: 180 }, NOW)).toBe(false);
    });
  });

  describe('describeCriteria', () => {
    it('reads each rule back in plain English', () => {
      expect(describeCriteria({ minStays: 1, notStayedForDays: 180, loyaltyTiers: ['Gold', 'Platinum'] })).toEqual([
        'Loyalty tier: Gold, Platinum',
        'At least 1 completed stay',
        "Hasn't stayed in 180 days",
      ]);
    });

    it('says what an empty segment means', () => {
      expect(describeCriteria({})).toEqual(['Every guest who has opted in to marketing']);
    });
  });
});
