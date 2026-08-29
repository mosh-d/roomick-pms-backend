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

/** `HH:MM:SS` component of a `Branch.checkInTime`/`checkOutTime` value — both are stored as `@db.Time` on an arbitrary 1970-01-01 date; only the time-of-day part is ever real. */
export function timeOfDay(time: Date): string {
  return time.toISOString().slice(11, 19);
}

/**
 * The real-world UTC instant of `time` (a branch's own check-in/check-out
 * clock time, `HH:MM:SS`) on the calendar day `dateOnly` represents, in
 * `timezone` — used to tell whether a reservation is genuinely overdue yet
 * (a guest isn't a "missed check-in"/"overdue checkout" the instant the
 * calendar date begins at midnight; only once the branch's own posted
 * check-in/check-out clock time on that date has actually passed).
 *
 * Zero-dependency IANA timezone arithmetic: format the same naive instant
 * through both "UTC" and the real `timezone`, re-parse each string with the
 * Date constructor, and diff — both re-parses go through the SAME (whatever
 * it is) local-machine timezone, so that bias cancels out of the
 * subtraction regardless of what it actually is. This is the standard
 * zero-library trick for this; it's off by up to an hour only in the literal
 * hour of a DST transition, which is immaterial for a check-in/check-out
 * cutoff.
 */
export function branchCutoffInstant(dateOnly: Date, time: string, timezone: string): Date {
  const guess = new Date(`${dateOnly.toISOString().slice(0, 10)}T${time}.000Z`);
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  const asTz = new Date(guess.toLocaleString('en-US', { timeZone: timezone }));
  return new Date(guess.getTime() + (asUtc.getTime() - asTz.getTime()));
}

export function hasPassedBranchCutoff(dateOnly: Date, time: string, timezone: string, now: Date = new Date()): boolean {
  return now.getTime() >= branchCutoffInstant(dateOnly, time, timezone).getTime();
}
