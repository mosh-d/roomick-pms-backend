/**
 * What another system can be told about through a webhook.
 *
 * These names are a contract: a receiver's code switches on them, so an event
 * is only ever added here — never renamed, never repurposed.
 */
export const WEBHOOK_EVENTS = [
  { type: 'reservation.created', label: 'Booking made', description: 'A new booking — front desk, booking engine, group block or walk-in' },
  {
    type: 'reservation.updated',
    label: 'Booking changed',
    description: 'Dates, room type, guests or rate changed, a stay extended, a waitlisted booking confirmed, or a no-show reinstated',
  },
  { type: 'reservation.cancelled', label: 'Booking cancelled', description: 'Cancelled by the guest online or by staff' },
  { type: 'reservation.checked_in', label: 'Guest checked in', description: 'Checked in at the desk, as part of a group, or as a walk-in' },
  { type: 'reservation.checked_out', label: 'Guest checked out', description: 'The stay is over and the room is free to clean' },
  { type: 'reservation.no_show', label: 'No-show', description: 'The guest didn’t arrive — marked by staff or the night audit' },
  { type: 'reservation.walked', label: 'Guest walked', description: 'Relocated to another property because no room was free' },
  { type: 'reservation.room_moved', label: 'Room move', description: 'An in-house guest moved to another room' },
  { type: 'payment.received', label: 'Payment received', description: 'A payment recorded on a bill, loyalty points included' },
  { type: 'refund.paid', label: 'Refund paid out', description: 'Money handed back to a guest' },
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]['type'];

export const WEBHOOK_EVENT_TYPES: readonly string[] = WEBHOOK_EVENTS.map((event) => event.type);

/** Sent only by "Send test" — never subscribed to, never sent by a real change. */
export const TEST_EVENT_TYPE = 'webhook.test';

/**
 * The reservation audit actions that are webhook events. A reservation's
 * every change already goes through `ReservationsService.audit`, so that's
 * where the events are raised — nothing that changes a booking can skip it.
 */
export const RESERVATION_ACTION_EVENTS: Readonly<Record<string, readonly WebhookEventType[]>> = {
  'reservation.created': ['reservation.created'],
  // A walk-in is booked and checked in in one step; a receiver listening for
  // either should hear about it.
  'reservation.walk_in': ['reservation.created', 'reservation.checked_in'],
  'reservation.checked_in': ['reservation.checked_in'],
  'reservation.checked_out': ['reservation.checked_out'],
  'reservation.cancelled': ['reservation.cancelled'],
  'reservation.no_show': ['reservation.no_show'],
  'reservation.reinstated': ['reservation.updated'],
  'reservation.modified': ['reservation.updated'],
  'reservation.extended': ['reservation.updated'],
  'reservation.rate_overridden': ['reservation.updated'],
  'reservation.promoted': ['reservation.updated'],
  'reservation.walked': ['reservation.walked'],
  'reservation.room_moved': ['reservation.room_moved'],
};

/** The body of every delivery. `id` is the event's, the same for each webhook told about it — what a receiver de-duplicates on. */
export interface WebhookPayload {
  id: string;
  type: string;
  createdAt: string;
  tenantId: string;
  branchId: string | null;
  data: Record<string, unknown>;
}
