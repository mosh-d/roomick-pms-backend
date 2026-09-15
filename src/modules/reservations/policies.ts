import { PenaltyType, Prisma } from '@prisma/client';
import { branchCutoffInstant, timeOfDay } from '../../common/utils/branch-date';

/**
 * Reservation policies: the branch cancellation policy, and the penalty
 * arithmetic it shares with no-shows. Pure functions — every input, "now"
 * included, is passed in, so the rules are testable without a database or a
 * clock.
 */

/** `Branch.cancellationPolicy`, resolved against the standard default. */
export interface CancellationPolicy {
  /** Free cancellation until this many hours before check-in time on the arrival day. 0 = free right up to check-in time. */
  freeCancellationHours: number;
  /** What a cancellation inside that window costs. */
  lateCancellationPenalty: PenaltyType;
  /** `flat_fee` only. */
  flatFeeAmount: number | null;
  /** Whether guests may cancel from "Manage your booking". Staff can always cancel. */
  allowOnlineCancellation: boolean;
}

/**
 * The standard hotel default, used by any branch that hasn't saved its own
 * (the column is NULL until an owner does): free until 24 hours before
 * check-in, the first night charged after that. Agreed with the owner as the
 * starting point — see the Owner Checklist.
 */
export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
  freeCancellationHours: 24,
  lateCancellationPenalty: 'first_night',
  flatFeeAmount: null,
  allowOnlineCancellation: true,
};

/** Statuses a booking can be cancelled from. Anything else has either started, ended, or already been resolved. */
export const CANCELLABLE_STATUSES = new Set(['confirmed', 'waitlisted']);

export const PENALTY_LABELS: Record<PenaltyType, string> = {
  first_night: 'first night',
  full_stay: 'full stay',
  flat_fee: 'flat fee',
  none: 'none',
};

const PENALTY_TYPES = new Set<string>(['first_night', 'full_stay', 'flat_fee', 'none']);

/** Reads the stored JSON defensively — anything missing or malformed falls back to the default rather than to "free". */
export function resolveCancellationPolicy(stored: unknown): CancellationPolicy {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const hours = s.freeCancellationHours;
  return {
    freeCancellationHours:
      typeof hours === 'number' && Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_CANCELLATION_POLICY.freeCancellationHours,
    lateCancellationPenalty:
      typeof s.lateCancellationPenalty === 'string' && PENALTY_TYPES.has(s.lateCancellationPenalty)
        ? (s.lateCancellationPenalty as PenaltyType)
        : DEFAULT_CANCELLATION_POLICY.lateCancellationPenalty,
    flatFeeAmount: typeof s.flatFeeAmount === 'number' && s.flatFeeAmount > 0 ? s.flatFeeAmount : null,
    allowOnlineCancellation:
      typeof s.allowOnlineCancellation === 'boolean' ? s.allowOnlineCancellation : DEFAULT_CANCELLATION_POLICY.allowOnlineCancellation,
  };
}

type PricedStay = { confirmedRate: Prisma.Decimal; overrideRate: Prisma.Decimal | null; checkInDate: Date; checkOutDate: Date };

/**
 * Pre-tax penalty for a stay; `null` = nothing to charge. One function for
 * no-shows and late cancellations, so "first night" can't be priced two
 * different ways. Same derivation as the nightly room charge: `overrideRate`
 * is an absolute nightly rate, `confirmedRate` the stay total.
 */
export function penaltyAmountFor(stay: PricedStay, penaltyType: PenaltyType, flatFeeAmount: number | null | undefined): Prisma.Decimal | null {
  const nights = Math.max(1, Math.round((stay.checkOutDate.getTime() - stay.checkInDate.getTime()) / 86_400_000));
  switch (penaltyType) {
    case 'first_night':
      return stay.overrideRate ? new Prisma.Decimal(stay.overrideRate) : new Prisma.Decimal(stay.confirmedRate).div(nights).toDecimalPlaces(2);
    case 'full_stay':
      return new Prisma.Decimal(stay.confirmedRate);
    case 'flat_fee':
      return flatFeeAmount ? new Prisma.Decimal(flatFeeAmount) : null;
    default:
      return null;
  }
}

export interface CancellationTerms {
  /** Check-in time on the arrival day, as a real instant in the branch's timezone. */
  checkInAt: Date;
  /** Cancelling before this instant is free. */
  freeUntil: Date;
  withinFreeWindow: boolean;
  /** The stay is due to have started. Guests can no longer cancel online — the no-show policy is what applies now. */
  pastCheckInTime: boolean;
  /** `none` when nothing is charged. */
  penaltyType: PenaltyType;
  /** Pre-tax; zero when nothing is charged. */
  penaltyAmount: Prisma.Decimal;
}

export function cancellationTermsFor(
  stay: PricedStay & { status: string },
  branch: { timezone: string; checkInTime: Date },
  policy: CancellationPolicy,
  now: Date,
): CancellationTerms {
  const checkInAt = branchCutoffInstant(stay.checkInDate, timeOfDay(branch.checkInTime), branch.timezone);
  const freeUntil = new Date(checkInAt.getTime() - policy.freeCancellationHours * 3_600_000);
  // A waitlisted booking never held a room, so releasing it costs the property nothing.
  const withinFreeWindow = stay.status === 'waitlisted' || now.getTime() < freeUntil.getTime();
  const amount = withinFreeWindow ? null : penaltyAmountFor(stay, policy.lateCancellationPenalty, policy.flatFeeAmount);
  const penaltyAmount = amount && amount.greaterThan(0) ? amount : new Prisma.Decimal(0);
  return {
    checkInAt,
    freeUntil,
    withinFreeWindow,
    pastCheckInTime: now.getTime() >= checkInAt.getTime(),
    penaltyType: penaltyAmount.isZero() ? 'none' : policy.lateCancellationPenalty,
    penaltyAmount,
  };
}

/**
 * The policy as one sentence, generated from the same object the charge is
 * computed from — so what a guest reads can't disagree with what they're
 * charged. Deliberately not a free-text field (the reference has a policy
 * text editor): hand-written policy text is exactly what ends up promising
 * something the system doesn't enforce.
 */
export function describeCancellationPolicy(policy: CancellationPolicy, checkInTime: string, currency: string): string {
  const fee = policy.flatFeeAmount;
  const penalty =
    policy.lateCancellationPenalty === 'first_night'
      ? 'the first night is charged'
      : policy.lateCancellationPenalty === 'full_stay'
        ? 'the full stay is charged'
        : policy.lateCancellationPenalty === 'flat_fee' && fee
          ? `a fee of ${currency} ${fee.toFixed(2)} is charged`
          : null;
  if (!penalty) return `Free cancellation until check-in time (${checkInTime}) on your arrival day.`;
  const deadline =
    policy.freeCancellationHours === 0
      ? `until check-in time (${checkInTime}) on your arrival day`
      : `until ${policy.freeCancellationHours} hour${policy.freeCancellationHours === 1 ? '' : 's'} before check-in (${checkInTime} on your arrival day)`;
  return `Free cancellation ${deadline}. After that, ${penalty}.`;
}

/** What cancelling costs right now — the reference's Cancellation Policy summary and Penalty / Refund figures, all computed. */
export interface CancellationQuote {
  reservationId: string;
  status: string;
  cancellable: boolean;
  currency: string;
  policy: CancellationPolicy & { summary: string };
  checkInAt: Date;
  freeCancellationUntil: Date;
  withinFreeWindow: boolean;
  pastCheckInTime: boolean;
  penaltyType: PenaltyType;
  penaltyAmount: string;
  penaltyTax: string;
  penaltyTotal: string;
  /** Payments already on the primary folio (zero for a pay-at-property booking). */
  paidSoFar: string;
  /** What the property owes back after the charge. Refunds aren't automated — this is the figure staff act on. */
  refundDue: string;
  /** What the guest still owes after anything already paid. */
  amountOwed: string;
}
