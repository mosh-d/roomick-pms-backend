import { ExecutionContext } from '@nestjs/common';
import { guestCredentialsThrottleKey } from './public-booking.controller';

/** A stand-in for the two handlers the throttler would otherwise key separately. */
function contextFor(handlerName: string): ExecutionContext {
  return {
    getClass: () => ({ name: 'PublicBookingController' }),
    getHandler: () => ({ name: handlerName }),
  } as unknown as ExecutionContext;
}

describe('guest-credential throttle key', () => {
  it('is the same for every credential route, so they share one budget per IP', () => {
    const lookup = guestCredentialsThrottleKey(contextFor('lookupBooking'), '203.0.113.7', 'default');
    const messages = guestCredentialsThrottleKey(contextFor('sendGuestMessage'), '203.0.113.7', 'default');
    expect(lookup).toBe(messages);
  });

  it('still separates different IPs', () => {
    expect(guestCredentialsThrottleKey(contextFor('lookupBooking'), '203.0.113.7', 'default')).not.toBe(
      guestCredentialsThrottleKey(contextFor('lookupBooking'), '198.51.100.2', 'default'),
    );
  });
});
