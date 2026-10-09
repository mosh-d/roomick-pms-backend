import { Prisma } from '@prisma/client';

/** A branch's day-use hours, `HH:mm` in its own timezone. */
export interface DayUseHours {
  from: string;
  until: string;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `Branch.dayUsePolicy`, read defensively — `null` when the branch doesn't sell day use. */
export function dayUseHoursFor(stored: Prisma.JsonValue | null | undefined): DayUseHours | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const { from, until } = stored as Record<string, unknown>;
  if (typeof from !== 'string' || typeof until !== 'string' || !CLOCK.test(from) || !CLOCK.test(until) || until <= from) return null;
  return { from, until };
}
