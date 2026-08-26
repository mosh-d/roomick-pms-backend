/**
 * Business-date helpers for branch-timezone logic (spec §6: "all business-
 * date logic… uses the branch timezone, never server time"). No date
 * library is installed — `Intl.DateTimeFormat` already gives everything
 * needed with zero dependencies.
 */

/** "Today" as a `YYYY-MM-DD` string in the given IANA timezone. */
export function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

/** Parses a `YYYY-MM-DD` string as a UTC-midnight `Date` — matches how Prisma reads/writes `@db.Date` columns. */
export function toBranchDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}
