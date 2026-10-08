import { Prisma } from '@prisma/client';
import { manageBookingLine } from './guest-links';

type BranchForMessages = {
  name: string;
  currency: string;
  address: Prisma.JsonValue;
  checkInTime: Date;
  checkOutTime: Date;
  bookingEngineEnabled: boolean;
  bookingSlug: string | null;
};

/** "14:00" from a time-of-day column (a 1970-01-01 Date). */
const clock = (time: Date): string => time.toISOString().slice(11, 16);

/** "1 Test Street, Lagos, NG" from the branch's address record — whichever parts are filled in. */
function addressLine(address: Prisma.JsonValue): string {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return '';
  const parts = ['street', 'city', 'state', 'country'].map((key) => (address as Record<string, unknown>)[key]).filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return parts.join(', ');
}

/**
 * The confirmation a guest gets when a booking is made. It used to say
 * "Your reservation is confirmed — Standard, 2026-10-07 to 2026-10-10" and
 * nothing else; a guest expects the rate and total, how many nights, when
 * they can arrive and must leave, and where the property is.
 */
export function bookingConfirmationBody(input: {
  guestName: string;
  confirmationNumber: string;
  branch: BranchForMessages;
  roomTypeName: string;
  checkInDate: string;
  checkOutDate: string;
  adults: number;
  children: number;
  /** The stay's room charges before tax. */
  subtotal: Prisma.Decimal;
  /** Tax added on top; zero when rates are tax-inclusive or no tax applies. */
  taxTotal: Prisma.Decimal;
  total: Prisma.Decimal;
}): string {
  const nights = Math.max(1, Math.round((Date.parse(input.checkOutDate) - Date.parse(input.checkInDate)) / 86_400_000));
  const { branch } = input;
  const money = (amount: Prisma.Decimal) => `${branch.currency} ${amount.toFixed(2)}`;
  const guests = `${input.adults} ${input.adults === 1 ? 'adult' : 'adults'}${input.children > 0 ? `, ${input.children} ${input.children === 1 ? 'child' : 'children'}` : ''}`;
  const price = input.taxTotal.isZero() ? `${money(input.total)} for the stay` : `${money(input.subtotal)} for the stay + ${money(input.taxTotal)} tax = ${money(input.total)} in all`;
  const where = addressLine(branch.address);

  return [
    `Dear ${input.guestName},`,
    '',
    `Your reservation ${input.confirmationNumber} at ${branch.name} is confirmed.`,
    '',
    `Room: ${input.roomTypeName} — ${nights} ${nights === 1 ? 'night' : 'nights'}, ${input.checkInDate} to ${input.checkOutDate}`,
    `Guests: ${guests}`,
    `Check-in from ${clock(branch.checkInTime)} · Check-out by ${clock(branch.checkOutTime)}`,
    `Rate: ${price}`,
    '',
    branch.name,
    ...(where ? [where] : []),
  ].join('\n') + manageBookingLine(branch, input.confirmationNumber);
}
