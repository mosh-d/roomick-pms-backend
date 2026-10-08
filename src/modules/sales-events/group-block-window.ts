/** How far outside a block's own nights a group booking may reach — the early-arrival and late-departure nights a group contract covers. */
export const SHOULDER_NIGHTS = 2;

/**
 * A block books its own nights only. Its rate was negotiated for those
 * dates; a booking outside them took a room off the block's allotment while
 * the guest paid the group rate for a weekend months away. A block made
 * before stay dates existed has none to check against.
 *
 * Shared by booking into a block and by changing a group booking's dates
 * later (modify, reinstating a no-show) — a group booking moved outside its
 * block kept the block's rate and allotment just the same.
 *
 * Returns why the stay is outside, or `null` when it's within.
 */
export function outsideGroupBlock(block: { arrivalDate: Date | null; departureDate: Date | null }, checkInDate: string, checkOutDate: string): string | null {
  const arrival = block.arrivalDate ? block.arrivalDate.toISOString().slice(0, 10) : null;
  const departure = block.departureDate ? block.departureDate.toISOString().slice(0, 10) : null;
  if (!arrival || !departure) return null;
  // A group contract usually covers a night or two either side of the event
  // for early arrivals and late departures — the shoulder nights. Anything
  // beyond that is not the group's stay.
  const shift = (day: string, nights: number) => new Date(new Date(`${day}T00:00:00.000Z`).getTime() + nights * 86_400_000).toISOString().slice(0, 10);
  if (checkInDate < shift(arrival, -SHOULDER_NIGHTS) || checkOutDate > shift(departure, SHOULDER_NIGHTS)) {
    return `the stay must fall within the block's dates (${arrival} to ${departure}, give or take ${SHOULDER_NIGHTS} shoulder nights) — book other dates as an ordinary reservation`;
  }
  return null;
}
