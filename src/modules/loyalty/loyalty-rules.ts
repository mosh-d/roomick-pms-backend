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

/** When points earned at `earnedAt` lapse under a programme that lets them, or null. Same day of the month, months later (clamped to the month's last day). */
export function pointsExpireAt(earnedAt: Date, months: number | null | undefined): Date | null {
  if (!months) return null;
  const at = new Date(earnedAt);
  const day = at.getUTCDate();
  at.setUTCDate(1);
  at.setUTCMonth(at.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
  at.setUTCDate(Math.min(day, lastDay));
  return at;
}

export type LedgerRow = { type: 'earn' | 'redeem' | 'adjust' | 'expire' | 'reversal'; points: number; expiresAt: Date | null };

/**
 * What of a member's points has lapsed unspent as of `now`, and what lapses
 * next. Spending is drawn from the earnings that lapse soonest — redeemed
 * points, points taken off, and points already lapsed all come off them
 * first (a voided redemption's points coming back puts them back) — so a
 * member never loses points while ones that last longer would have done.
 * Points that never lapse (an adjustment, or earned while the programme let
 * points last for ever) are spent only once those are gone.
 */
export function lapsedPoints(rows: LedgerRow[], now: Date): { due: number; next: { points: number; on: Date } | null } {
  let spent = 0;
  for (const row of rows) {
    if (row.type === 'redeem' || row.type === 'expire' || (row.type === 'adjust' && row.points < 0)) spent += -row.points;
    if (row.type === 'reversal') spent -= row.points;
  }
  spent = Math.max(0, spent);
  const lots = rows.filter((row) => row.type === 'earn' && row.expiresAt !== null).sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime());
  let due = 0;
  let next: { points: number; on: Date } | null = null;
  for (const lot of lots) {
    const used = Math.min(lot.points, spent);
    spent -= used;
    const unspent = lot.points - used;
    if (unspent <= 0) continue;
    if (lot.expiresAt! <= now) due += unspent;
    else if (!next) next = { points: unspent, on: lot.expiresAt! };
    else if (next.on.getTime() === lot.expiresAt!.getTime()) next.points += unspent;
  }
  const balance = rows.reduce((sum, row) => sum + row.points, 0);
  return { due: Math.max(0, Math.min(due, balance)), next };
}

