import { Prisma } from '@prisma/client';

/**
 * Deposits: what a booking is asked to pay ahead, from the branch's deposit
 * policy (`Branch.depositPolicy`). Pure functions — the stay's price and the
 * booking date are passed in.
 *
 * Worked out when the stay is booked and written onto it
 * (`Reservation.depositAmount`/`depositDueDate`), so a later policy change
 * doesn't move what a guest was already told.
 */
export type DepositType = 'none' | 'first_night' | 'percentage' | 'fixed';

export interface DepositPolicy {
  type: DepositType;
  /** `percentage`: of the stay's total, tax included. `fixed`: the amount. */
  value: number | null;
  /** Due this many days before arrival — or at once, for a booking made closer in than that. 0 = by arrival. */
  dueDaysBeforeArrival: number;
}

const TYPES = new Set<string>(['none', 'first_night', 'percentage', 'fixed']);

/** The stored policy, read defensively; anything unusable means no deposit is asked. */
export function resolveDepositPolicy(stored: Prisma.JsonValue | null | undefined): DepositPolicy | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const s = stored as Record<string, unknown>;
  if (typeof s.type !== 'string' || !TYPES.has(s.type) || s.type === 'none') return null;
  const value = typeof s.value === 'number' && Number.isFinite(s.value) && s.value > 0 ? s.value : null;
  if ((s.type === 'percentage' || s.type === 'fixed') && value === null) return null;
  if (s.type === 'percentage' && value !== null && value > 100) return null;
  const days = typeof s.dueDaysBeforeArrival === 'number' && Number.isInteger(s.dueDaysBeforeArrival) && s.dueDaysBeforeArrival >= 0 ? s.dueDaysBeforeArrival : 0;
  return { type: s.type as DepositType, value, dueDaysBeforeArrival: days };
}

export interface PricedForDeposit {
  checkInDate: Date;
  /** The room price for the stay, before any tax added on top. */
  subtotal: Prisma.Decimal;
  /** What the guest pays for the room: `subtotal` plus tax added on top. */
  totalWithTax: Prisma.Decimal;
  /** The first night's own room price. */
  firstNight: Prisma.Decimal;
}

/**
 * The deposit asked for a stay, and when it's due; `null` = none. The first
 * night carries its share of the stay's tax, so a first-night deposit covers
 * what the first night will actually cost. Never more than the stay itself.
 */
export function depositFor(policy: DepositPolicy | null, stay: PricedForDeposit, bookedOn: Date): { amount: Prisma.Decimal; dueDate: Date } | null {
  if (!policy) return null;
  let amount: Prisma.Decimal;
  switch (policy.type) {
    case 'first_night':
      amount = stay.subtotal.greaterThan(0) ? stay.firstNight.mul(stay.totalWithTax).div(stay.subtotal) : stay.firstNight;
      break;
    case 'percentage':
      amount = stay.totalWithTax.mul(policy.value ?? 0).div(100);
      break;
    case 'fixed':
      amount = new Prisma.Decimal(policy.value ?? 0);
      break;
    default:
      return null;
  }
  amount = Prisma.Decimal.min(amount, stay.totalWithTax).toDecimalPlaces(2);
  if (!amount.greaterThan(0)) return null;
  const due = new Date(stay.checkInDate.getTime() - policy.dueDaysBeforeArrival * 86_400_000);
  return { amount, dueDate: due.getTime() < bookedOn.getTime() ? bookedOn : due };
}

/** "₦25,000.00 (the first night), due 12 Oct 2026" — the booking confirmation's line. */
export function describeDeposit(amount: Prisma.Decimal, dueDate: Date, currency: string): string {
  const due = dueDate.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  return `A deposit of ${currency} ${amount.toFixed(2)} is due by ${due}.`;
}
