import { Prisma } from '@prisma/client';
import { branchCutoffInstant, timeOfDay } from '../../common/utils/branch-date';
import { nightlyRateFor } from './nightly-rates';

/**
 * Late check-out and early departure fees (`Branch.stayFeePolicy`). Pure
 * functions — the stay, the branch and "now" are passed in.
 *
 * - **Late check-out**: leaving after the branch's check-out time (plus any
 *   grace) on the day the stay ends or later. A flat amount, or a share of a
 *   night's price. Nights the guest actually stayed over are the night
 *   audit's to charge, not this.
 * - **Early departure**: leaving before the booked last night. A flat amount,
 *   one night's price, or a share of the nights given up.
 */
export interface LateCheckoutPolicy {
  graceMinutes: number;
  feeType: 'flat' | 'percent_of_night';
  amount: number;
}

export interface EarlyDeparturePolicy {
  feeType: 'flat' | 'first_night' | 'percent_of_remaining';
  amount: number | null;
}

export interface StayFeePolicy {
  lateCheckout: LateCheckoutPolicy | null;
  earlyDeparture: EarlyDeparturePolicy | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const positive = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

/** The stored policy, read defensively — anything unusable charges nothing. */
export function resolveStayFeePolicy(stored: Prisma.JsonValue | null | undefined): StayFeePolicy {
  const s = record(stored) ?? {};
  const late = record(s.lateCheckout);
  const early = record(s.earlyDeparture);
  const lateAmount = positive(late?.amount);
  const lateType = late?.feeType === 'flat' || late?.feeType === 'percent_of_night' ? late.feeType : null;
  const grace = typeof late?.graceMinutes === 'number' && Number.isInteger(late.graceMinutes) && late.graceMinutes >= 0 ? late.graceMinutes : 0;
  const earlyType = early?.feeType === 'flat' || early?.feeType === 'first_night' || early?.feeType === 'percent_of_remaining' ? early.feeType : null;
  const earlyAmount = positive(early?.amount);
  return {
    lateCheckout: lateType && lateAmount !== null && !(lateType === 'percent_of_night' && lateAmount > 100) ? { graceMinutes: grace, feeType: lateType, amount: lateAmount } : null,
    earlyDeparture:
      earlyType && (earlyType === 'first_night' || (earlyAmount !== null && !(earlyType === 'percent_of_remaining' && earlyAmount > 100)))
        ? { feeType: earlyType, amount: earlyType === 'first_night' ? null : earlyAmount }
        : null,
  };
}

export interface StayForFees {
  checkInDate: Date;
  checkOutDate: Date;
  confirmedRate: Prisma.Decimal;
  overrideRate: Prisma.Decimal | null;
  nightlyRates: Prisma.JsonValue | null;
}

export interface StayFee {
  kind: 'late_checkout' | 'early_departure';
  /** Pre-tax. */
  amount: Prisma.Decimal;
  description: string;
}

/** A night's price for this stay: the override, the night's own quote, or the stay split evenly. */
function nightPrice(stay: StayForFees, night: Date): Prisma.Decimal {
  if (stay.overrideRate) return new Prisma.Decimal(stay.overrideRate);
  const nights = Math.max(1, Math.round((stay.checkOutDate.getTime() - stay.checkInDate.getTime()) / 86_400_000));
  return nightlyRateFor({ nightlyRates: stay.nightlyRates }, night) ?? new Prisma.Decimal(stay.confirmedRate).div(nights).toDecimalPlaces(2);
}

/** What leaving now costs beyond the nights stayed. `today` is the branch's own date. */
export function stayFeesFor(policy: StayFeePolicy, stay: StayForFees, branch: { timezone: string; checkOutTime: Date }, today: Date, now: Date): StayFee[] {
  const fees: StayFee[] = [];
  const day = 86_400_000;

  if (policy.earlyDeparture && today.getTime() < stay.checkOutDate.getTime()) {
    // Nights given up: tonight up to (not including) the booked departure day.
    const remaining: Date[] = [];
    for (let night = new Date(Math.max(today.getTime(), stay.checkInDate.getTime())); night < stay.checkOutDate; night = new Date(night.getTime() + day)) remaining.push(night);
    let amount: Prisma.Decimal;
    const { feeType } = policy.earlyDeparture;
    if (feeType === 'flat') amount = new Prisma.Decimal(policy.earlyDeparture.amount ?? 0);
    else if (feeType === 'first_night') amount = remaining.length ? nightPrice(stay, remaining[0]) : new Prisma.Decimal(0);
    else amount = remaining.reduce((sum, night) => sum.plus(nightPrice(stay, night)), new Prisma.Decimal(0)).mul(policy.earlyDeparture.amount ?? 0).div(100);
    amount = amount.toDecimalPlaces(2);
    const given = remaining.length;
    if (amount.greaterThan(0)) fees.push({ kind: 'early_departure', amount, description: `Early departure fee (${given} night${given === 1 ? '' : 's'} given up)` });
  }

  if (policy.lateCheckout && today.getTime() >= stay.checkOutDate.getTime()) {
    const deadline = branchCutoffInstant(today, timeOfDay(branch.checkOutTime), branch.timezone).getTime() + policy.lateCheckout.graceMinutes * 60_000;
    if (now.getTime() > deadline) {
      const lastNight = new Date(stay.checkOutDate.getTime() - day);
      const amount = (
        policy.lateCheckout.feeType === 'flat' ? new Prisma.Decimal(policy.lateCheckout.amount) : nightPrice(stay, lastNight).mul(policy.lateCheckout.amount).div(100)
      ).toDecimalPlaces(2);
      if (amount.greaterThan(0)) fees.push({ kind: 'late_checkout', amount, description: 'Late check-out fee' });
    }
  }
  return fees;
}
