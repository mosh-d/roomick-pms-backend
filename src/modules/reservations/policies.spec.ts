import { Prisma } from '@prisma/client';
import {
  CancellationPolicy,
  DEFAULT_CANCELLATION_POLICY,
  cancellationTermsFor,
  describeCancellationPolicy,
  penaltyAmountFor,
  resolveCancellationPolicy,
} from './policies';

/** Lagos is UTC+1 all year, so a 14:00 check-in is 13:00Z. */
const LAGOS = { timezone: 'Africa/Lagos', checkInTime: new Date('1970-01-01T14:00:00.000Z') };

function stay(overrides: Partial<{ status: string; overrideRate: Prisma.Decimal | null; confirmedRate: Prisma.Decimal }> = {}) {
  return {
    status: 'confirmed',
    checkInDate: new Date('2026-10-10T00:00:00.000Z'),
    checkOutDate: new Date('2026-10-13T00:00:00.000Z'),
    confirmedRate: new Prisma.Decimal('90000'),
    overrideRate: null as Prisma.Decimal | null,
    ...overrides,
  };
}

const policy = (overrides: Partial<CancellationPolicy> = {}): CancellationPolicy => ({ ...DEFAULT_CANCELLATION_POLICY, ...overrides });

describe('reservation policies', () => {
  describe('resolveCancellationPolicy', () => {
    it('a branch that never saved a policy gets the standard default — 24 hours, first night', () => {
      expect(resolveCancellationPolicy(null)).toEqual(DEFAULT_CANCELLATION_POLICY);
      expect(DEFAULT_CANCELLATION_POLICY).toMatchObject({ freeCancellationHours: 24, lateCancellationPenalty: 'first_night', allowOnlineCancellation: true });
    });

    it("keeps a branch's saved policy", () => {
      const saved = { freeCancellationHours: 48, lateCancellationPenalty: 'flat_fee', flatFeeAmount: 5000, allowOnlineCancellation: false };
      expect(resolveCancellationPolicy(saved)).toEqual(saved);
    });

    it('falls back to the default — never to "free" — for anything malformed', () => {
      expect(resolveCancellationPolicy({ freeCancellationHours: -5, lateCancellationPenalty: 'bogus', allowOnlineCancellation: 'yes' })).toEqual(
        DEFAULT_CANCELLATION_POLICY,
      );
    });
  });

  describe('cancellationTermsFor', () => {
    it("measures the window back from check-in time on the arrival day, in the branch's own timezone", () => {
      const terms = cancellationTermsFor(stay(), LAGOS, policy(), new Date('2026-10-01T00:00:00.000Z'));
      expect(terms.checkInAt.toISOString()).toBe('2026-10-10T13:00:00.000Z');
      expect(terms.freeUntil.toISOString()).toBe('2026-10-09T13:00:00.000Z');
    });

    it('is free up to the last moment of the window', () => {
      const terms = cancellationTermsFor(stay(), LAGOS, policy(), new Date('2026-10-09T12:59:59.999Z'));
      expect(terms).toMatchObject({ withinFreeWindow: true, penaltyType: 'none' });
      expect(terms.penaltyAmount.toFixed(2)).toBe('0.00');
    });

    it('charges the first night from the moment the window closes', () => {
      const terms = cancellationTermsFor(stay(), LAGOS, policy(), new Date('2026-10-09T13:00:00.000Z'));
      expect(terms).toMatchObject({ withinFreeWindow: false, pastCheckInTime: false, penaltyType: 'first_night' });
      expect(terms.penaltyAmount.toFixed(2)).toBe('30000.00'); // 90,000 over 3 nights
    });

    it('prices "first night" from a nightly override when the stay has one', () => {
      const terms = cancellationTermsFor(stay({ overrideRate: new Prisma.Decimal('25000') }), LAGOS, policy(), new Date('2026-10-09T13:00:00.000Z'));
      expect(terms.penaltyAmount.toFixed(2)).toBe('25000.00');
    });

    it('a waitlisted booking is always free — it never held a room', () => {
      const terms = cancellationTermsFor(stay({ status: 'waitlisted' }), LAGOS, policy(), new Date('2026-10-10T09:00:00.000Z'));
      expect(terms).toMatchObject({ withinFreeWindow: true, penaltyType: 'none' });
    });

    it('flags when check-in time itself has passed', () => {
      expect(cancellationTermsFor(stay(), LAGOS, policy(), new Date('2026-10-10T12:59:00.000Z')).pastCheckInTime).toBe(false);
      expect(cancellationTermsFor(stay(), LAGOS, policy(), new Date('2026-10-10T13:00:00.000Z')).pastCheckInTime).toBe(true);
    });

    it('0 hours means free right up to check-in time', () => {
      const terms = cancellationTermsFor(stay(), LAGOS, policy({ freeCancellationHours: 0 }), new Date('2026-10-10T12:00:00.000Z'));
      expect(terms.freeUntil.toISOString()).toBe('2026-10-10T13:00:00.000Z');
      expect(terms.withinFreeWindow).toBe(true);
    });

    it('a flat-fee policy with no amount set charges nothing rather than failing', () => {
      const terms = cancellationTermsFor(stay(), LAGOS, policy({ lateCancellationPenalty: 'flat_fee', flatFeeAmount: null }), new Date('2026-10-09T20:00:00.000Z'));
      expect(terms.penaltyType).toBe('none');
      expect(terms.penaltyAmount.isZero()).toBe(true);
    });
  });

  describe('penaltyAmountFor', () => {
    it('full stay is the whole confirmed rate', () => {
      expect(penaltyAmountFor(stay(), 'full_stay', null)?.toFixed(2)).toBe('90000.00');
    });

    it('flat fee is the configured amount', () => {
      expect(penaltyAmountFor(stay(), 'flat_fee', 7500)?.toFixed(2)).toBe('7500.00');
    });

    it('none is nothing', () => {
      expect(penaltyAmountFor(stay(), 'none', null)).toBeNull();
    });
  });

  describe('describeCancellationPolicy', () => {
    it('states the default in one sentence', () => {
      expect(describeCancellationPolicy(policy(), '14:00', 'NGN')).toBe(
        'Free cancellation until 24 hours before check-in (14:00 on your arrival day). After that, the first night is charged.',
      );
    });

    it('states a flat fee with its amount', () => {
      expect(describeCancellationPolicy(policy({ freeCancellationHours: 48, lateCancellationPenalty: 'flat_fee', flatFeeAmount: 5000 }), '15:00', 'NGN')).toBe(
        'Free cancellation until 48 hours before check-in (15:00 on your arrival day). After that, a fee of NGN 5000.00 is charged.',
      );
    });

    it('says plainly when cancelling is never charged', () => {
      expect(describeCancellationPolicy(policy({ lateCancellationPenalty: 'none' }), '14:00', 'NGN')).toBe(
        'Free cancellation until check-in time (14:00) on your arrival day.',
      );
    });

    it('handles a 0-hour window', () => {
      expect(describeCancellationPolicy(policy({ freeCancellationHours: 0 }), '14:00', 'NGN')).toBe(
        'Free cancellation until check-in time (14:00) on your arrival day. After that, the first night is charged.',
      );
    });
  });
});
