import { Prisma } from '@prisma/client';

/** What a tier can promise. Shown on the guest's profile for staff to honour — the system doesn't apply them itself. */
export const LOYALTY_BENEFITS = ['late_checkout', 'early_checkin', 'room_upgrade', 'welcome_drink', 'free_breakfast', 'lounge_access'] as const;

// A type alias, not an interface: it's written straight into a JSON column.
export type LoyaltyTier = { name: string; threshold: number; benefits: string[] };

/** Offered as a starting point until a programme is saved — the reference's own example tiers, plus a base tier every member starts in. */
export const SUGGESTED_TIERS: LoyaltyTier[] = [
  { name: 'Member', threshold: 0, benefits: [] },
  { name: 'Silver', threshold: 500, benefits: ['late_checkout'] },
  { name: 'Gold', threshold: 1500, benefits: ['room_upgrade', 'late_checkout'] },
  { name: 'Platinum', threshold: 5000, benefits: ['lounge_access', 'room_upgrade', 'late_checkout'] },
];

export function sortTiers(tiers: LoyaltyTier[]): LoyaltyTier[] {
  return [...tiers].sort((a, b) => a.threshold - b.threshold);
}

export function parseTiers(value: Prisma.JsonValue | null | undefined): LoyaltyTier[] {
  return Array.isArray(value) ? sortTiers(value as unknown as LoyaltyTier[]) : [];
}

/**
 * The highest tier a member's lifetime points have reached. Lifetime points
 * count everything ever earned or added and never go down, so redeeming
 * points never costs a member their tier.
 */
export function tierFor(tiers: LoyaltyTier[], lifetimePoints: number): LoyaltyTier | null {
  return sortTiers(tiers).filter((tier) => tier.threshold <= lifetimePoints).at(-1) ?? null;
}

export function nextTierFor(tiers: LoyaltyTier[], lifetimePoints: number): { name: string; pointsToGo: number } | null {
  const next = sortTiers(tiers).find((tier) => tier.threshold > lifetimePoints);
  return next ? { name: next.name, pointsToGo: next.threshold - lifetimePoints } : null;
}

/** Whole points for spend before tax — always rounded down, so a stay never earns a fraction nobody can redeem. */
export function pointsForSpend(spend: Prisma.Decimal, pointsPerUnit: Prisma.Decimal): number {
  if (!spend.greaterThan(0)) return 0;
  return spend.mul(pointsPerUnit).floor().toNumber();
}

/** What points are worth at redemption, rounded down to the cent — the house never pays out more than the points buy. */
export function redemptionValue(points: number, pointValue: Prisma.Decimal): Prisma.Decimal {
  return pointValue.mul(points).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
}
