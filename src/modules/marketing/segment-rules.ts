import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * What a saved audience is made of.
 *
 * Every field is optional and they AND together: a segment with no criteria
 * at all is "every guest who has opted in", which is a legitimate (if blunt)
 * audience. Nothing here needs a data warehouse — each one reduces to data
 * the PMS already holds about a guest, their stays and what they paid, which
 * is exactly what the growth plan's own note for this month says.
 */
export interface SegmentCriteria {
  /** `vipLevel >= n` (0–5). */
  vipLevelMin?: number;
  /** Any one of these loyalty tiers. */
  loyaltyTiers?: string[];
  /** Holds ANY of these CRM tags — not all of them. */
  tags?: string[];
  /** ISO 3166-1 alpha-2 country codes. */
  nationalities?: string[];
  /** Has completed a stay at any one of these branches. */
  branchIds?: string[];
  /** At least this many completed stays. */
  minStays?: number;
  /** Lifetime spend (the same figure the guest profile shows: every non-void payment across their folios). */
  minTotalSpend?: number;
  /** Checked out within the last n days — the "recent guests" audience. */
  lastStayWithinDays?: number;
  /** Has not checked out in n days, including never having stayed — the win-back audience. */
  notStayedForDays?: number;
}

/** The criteria keys, so an unknown one can be named in the error rather than silently ignored. */
export const SEGMENT_CRITERIA_KEYS = [
  'vipLevelMin',
  'loyaltyTiers',
  'tags',
  'nationalities',
  'branchIds',
  'minStays',
  'minTotalSpend',
  'lastStayWithinDays',
  'notStayedForDays',
] as const satisfies readonly (keyof SegmentCriteria)[];

/** What the aggregate half of the criteria is measured against, per guest. */
export interface GuestAggregates {
  /** Completed stays (checked out). */
  stays: number;
  /** Every non-void payment across the guest's folios. */
  totalSpend: Prisma.Decimal;
  /** The most recent completed stay's check-out date, or null for a guest who has never completed one. */
  lastStayAt: Date | null;
}

const NUMERIC_KEYS = ['vipLevelMin', 'minStays', 'minTotalSpend', 'lastStayWithinDays', 'notStayedForDays'] as const;
const LIST_KEYS = ['loyaltyTiers', 'tags', 'nationalities', 'branchIds'] as const;

/**
 * Reads criteria back off the stored JSON, defensively: a segment saved by an
 * older shape, or hand-edited in the database, must not send a campaign to an
 * audience nobody intended. Anything unrecognised is an error, never a
 * silently dropped filter — dropping one would widen the audience.
 */
export function parseCriteria(value: unknown): SegmentCriteria {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Segment criteria must be an object' });
  }
  const raw = value as Record<string, unknown>;
  const criteria: SegmentCriteria = {};

  for (const key of Object.keys(raw)) {
    if (raw[key] === null || raw[key] === undefined) continue;
    if (!(SEGMENT_CRITERIA_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `Unknown segment rule "${key}"` });
    }
  }

  for (const key of NUMERIC_KEYS) {
    const raw_value = raw[key];
    if (raw_value === undefined || raw_value === null) continue;
    const num = typeof raw_value === 'number' ? raw_value : Number(raw_value);
    if (!Number.isFinite(num) || num < 0) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `Segment rule "${key}" must be a number of 0 or more` });
    }
    criteria[key] = num;
  }

  for (const key of LIST_KEYS) {
    const raw_value = raw[key];
    if (raw_value === undefined || raw_value === null) continue;
    if (!Array.isArray(raw_value) || raw_value.some((item) => typeof item !== 'string' || item.trim() === '')) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `Segment rule "${key}" must be a list of values` });
    }
    const list = (raw_value as string[]).map((item) => item.trim());
    if (list.length > 0) criteria[key] = list;
  }

  assertCriteriaCoherent(criteria);
  return criteria;
}

/**
 * Two rules can be individually valid and still describe nobody. Saying so
 * when the segment is saved beats a campaign that quietly reaches zero
 * guests and looks like a delivery failure.
 */
export function assertCriteriaCoherent(criteria: SegmentCriteria): void {
  const { lastStayWithinDays, notStayedForDays } = criteria;
  if (lastStayWithinDays !== undefined && notStayedForDays !== undefined && notStayedForDays <= lastStayWithinDays) {
    throw new BadRequestException({
      code: ErrorCode.VALIDATION_FAILED,
      message: `No guest can both have stayed within ${lastStayWithinDays} days and not have stayed for ${notStayedForDays} days`,
    });
  }
  if (criteria.vipLevelMin !== undefined && criteria.vipLevelMin > 5) {
    throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'VIP level runs from 0 to 5' });
  }
}

/**
 * The aggregate half of the match, kept separate from the query so it can be
 * reasoned about (and tested) without a database: stays, spend and recency
 * are counted per guest by the service, then each guest is checked here.
 */
export function matchesAggregates(aggregates: GuestAggregates, criteria: SegmentCriteria, now: Date): boolean {
  if (criteria.minStays !== undefined && aggregates.stays < criteria.minStays) return false;
  if (criteria.minTotalSpend !== undefined && aggregates.totalSpend.lessThan(criteria.minTotalSpend)) return false;

  if (criteria.lastStayWithinDays !== undefined) {
    // A guest who has never stayed is not a recent guest.
    if (!aggregates.lastStayAt) return false;
    if (aggregates.lastStayAt < daysBefore(now, criteria.lastStayWithinDays)) return false;
  }

  if (criteria.notStayedForDays !== undefined) {
    // Never having stayed DOES satisfy "hasn't stayed in n days" — an enquiry
    // or a cancelled booking that never became a stay is a real win-back target.
    if (aggregates.lastStayAt && aggregates.lastStayAt >= daysBefore(now, criteria.notStayedForDays)) return false;
  }

  return true;
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/** One plain line per rule, for the segment card and the send confirmation — so nobody sends to an audience they can't read back. */
export function describeCriteria(criteria: SegmentCriteria): string[] {
  const lines: string[] = [];
  if (criteria.vipLevelMin !== undefined) lines.push(`VIP level ${criteria.vipLevelMin} or above`);
  if (criteria.loyaltyTiers?.length) lines.push(`Loyalty tier: ${criteria.loyaltyTiers.join(', ')}`);
  if (criteria.tags?.length) lines.push(`Tagged: ${criteria.tags.join(', ')}`);
  if (criteria.nationalities?.length) lines.push(`Nationality: ${criteria.nationalities.join(', ')}`);
  if (criteria.branchIds?.length) lines.push(`Has stayed at ${criteria.branchIds.length === 1 ? 'a chosen property' : `${criteria.branchIds.length} chosen properties`}`);
  if (criteria.minStays !== undefined) lines.push(`At least ${criteria.minStays} completed ${criteria.minStays === 1 ? 'stay' : 'stays'}`);
  if (criteria.minTotalSpend !== undefined) lines.push(`Has spent at least ${criteria.minTotalSpend}`);
  if (criteria.lastStayWithinDays !== undefined) lines.push(`Stayed in the last ${criteria.lastStayWithinDays} days`);
  if (criteria.notStayedForDays !== undefined) lines.push(`Hasn't stayed in ${criteria.notStayedForDays} days`);
  if (lines.length === 0) lines.push('Every guest who has opted in to marketing');
  return lines;
}

/**
 * Consent, a usable address and not-erased. This is the floor every audience
 * sits on rather than a rule inside the criteria, so there is no way to save
 * a segment that leaves it out.
 */
export const MARKETING_CONSENT_FLOOR = {
  marketingOptIn: true,
  email: { not: null },
} satisfies Prisma.GuestProfileWhereInput;

/**
 * The guest-level half of the match, as a Prisma filter.
 *
 * Recency is in here rather than in `matchesAggregates` on purpose: "hasn't
 * stayed in 180 days" is the single most common marketing audience there is,
 * and as `reservations: { none: … }` the database answers it against an index
 * instead of this process loading every guest to check.
 */
export function guestWhereFor(criteria: SegmentCriteria, now: Date): Prisma.GuestProfileWhereInput {
  const completedStay = { status: 'checked_out', deletedAt: null } as const;
  // Each stay-history rule is its own clause under AND rather than another
  // `reservations` key: three of them in one object literal would silently
  // overwrite each other and quietly change who receives the campaign.
  const stayRules: Prisma.GuestProfileWhereInput[] = [];
  if (criteria.branchIds?.length) {
    stayRules.push({ reservations: { some: { ...completedStay, branchId: { in: criteria.branchIds } } } });
  }
  if (criteria.lastStayWithinDays !== undefined) {
    stayRules.push({ reservations: { some: { ...completedStay, checkOutDate: { gte: daysBefore(now, criteria.lastStayWithinDays) } } } });
  }
  if (criteria.notStayedForDays !== undefined) {
    stayRules.push({ reservations: { none: { ...completedStay, checkOutDate: { gte: daysBefore(now, criteria.notStayedForDays) } } } });
  }

  return {
    deletedAt: null,
    ...(criteria.vipLevelMin !== undefined ? { vipLevel: { gte: criteria.vipLevelMin } } : {}),
    ...(criteria.loyaltyTiers?.length ? { loyaltyTier: { in: criteria.loyaltyTiers } } : {}),
    ...(criteria.tags?.length ? { tags: { hasSome: criteria.tags } } : {}),
    ...(criteria.nationalities?.length ? { nationality: { in: criteria.nationalities } } : {}),
    ...(stayRules.length ? { AND: stayRules } : {}),
  };
}

/**
 * Stay count and lifetime spend are the only two rules the database can't
 * filter on directly — neither is expressible as a relation filter — so they
 * cost one extra pass over the matched guests and are skipped when unused.
 */
export function needsAggregates(criteria: SegmentCriteria): boolean {
  return criteria.minStays !== undefined || criteria.minTotalSpend !== undefined;
}
