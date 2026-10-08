import { registerDecorator, ValidationOptions } from 'class-validator';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day written `YYYY-MM-DD` — `2026-02-30` and `2026-10-08T10:00:00Z` are both refused. */
export function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d);
}

/**
 * A business date — a check-in day, a service date, a report boundary —
 * which `toBranchDate` turns into midnight UTC of that calendar day.
 *
 * `@IsISO8601({ strict: true })` was used for these before, and it accepts
 * a full timestamp too: `?date=2026-10-08T10:00:00Z` passed validation,
 * `toBranchDate` made an Invalid Date of it, and Postgres answered with a
 * 500. Every date-only field validates here instead.
 */
export function IsDateOnly(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isDateOnly',
      target: object.constructor,
      propertyName: propertyName as string,
      options: { message: '$property must be a calendar date in YYYY-MM-DD form', ...validationOptions },
      validator: { validate: (value: unknown) => isDateOnly(value) },
    });
  };
}
