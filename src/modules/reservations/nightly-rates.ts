import { Prisma, Reservation } from '@prisma/client';

/**
 * The night's own price, as the resolver quoted it when the stay was booked
 * or last re-priced (`Reservation.nightlyRates`). Null for a stay from
 * before nights were kept — billed as the stay total split evenly, as before.
 *
 * Shared by the nightly room charge and the first-night penalty, so a
 * night can't be priced one way on the bill and another in a penalty.
 */
export function nightlyRateFor(reservation: Pick<Reservation, 'nightlyRates'>, serviceDate: Date): Prisma.Decimal | null {
  const nights = reservation.nightlyRates;
  if (!Array.isArray(nights)) return null;
  const day = serviceDate.toISOString().slice(0, 10);
  const night = nights.find((n): n is { date: string; rate: string | number } => typeof n === 'object' && n !== null && (n as { date?: unknown }).date === day);
  if (!night || (typeof night.rate !== 'string' && typeof night.rate !== 'number')) return null;
  const rate = new Prisma.Decimal(night.rate);
  return rate.isFinite() ? rate : null;
}
