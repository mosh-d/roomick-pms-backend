import { Prisma } from '@prisma/client';
import { bookingConfirmationBody } from './guest-messages';

const branch = {
  name: 'Lekki Suites',
  currency: 'NGN',
  address: { street: '12 Admiralty Way', city: 'Lagos', country: 'NG' },
  checkInTime: new Date('1970-01-01T14:00:00.000Z'),
  checkOutTime: new Date('1970-01-01T11:00:00.000Z'),
  bookingEngineEnabled: false,
  bookingSlug: null,
};

describe('bookingConfirmationBody', () => {
  it('tells the guest the nights, the rate and total, when to arrive and leave, and where', () => {
    const body = bookingConfirmationBody({
      guestName: 'Ada Obi',
      confirmationNumber: 'RES-2026-00042',
      branch,
      roomTypeName: 'Deluxe Room',
      checkInDate: '2026-10-07',
      checkOutDate: '2026-10-10',
      adults: 2,
      children: 1,
      subtotal: new Prisma.Decimal('135000'),
      taxTotal: new Prisma.Decimal('10125'),
      total: new Prisma.Decimal('145125'),
    });
    expect(body).toContain('Dear Ada Obi,');
    expect(body).toContain('Your reservation RES-2026-00042 at Lekki Suites is confirmed.');
    expect(body).toContain('Room: Deluxe Room — 3 nights, 2026-10-07 to 2026-10-10');
    expect(body).toContain('Guests: 2 adults, 1 child');
    expect(body).toContain('Check-in from 14:00 · Check-out by 11:00');
    expect(body).toContain('Rate: NGN 135000.00 for the stay + NGN 10125.00 tax = NGN 145125.00 in all');
    expect(body).toContain('12 Admiralty Way, Lagos, NG');
    expect(body).not.toContain('Manage your booking'); // the booking pages are off at this branch
  });

  it('with no tax to add, states one figure — and a manage link when the booking pages are on', () => {
    const body = bookingConfirmationBody({
      guestName: 'Ada Obi',
      confirmationNumber: 'RES-2026-00043',
      branch: { ...branch, bookingEngineEnabled: true, bookingSlug: 'lekki-suites' },
      roomTypeName: 'Standard',
      checkInDate: '2026-10-07',
      checkOutDate: '2026-10-08',
      adults: 1,
      children: 0,
      subtotal: new Prisma.Decimal('45000'),
      taxTotal: new Prisma.Decimal(0),
      total: new Prisma.Decimal('45000'),
    });
    expect(body).toContain('Room: Standard — 1 night, 2026-10-07 to 2026-10-08');
    expect(body).toContain('Guests: 1 adult');
    expect(body).toContain('Rate: NGN 45000.00 for the stay');
    expect(body).toContain('Manage your booking: ');
    expect(body).toContain('confirmation=RES-2026-00043');
  });
});
