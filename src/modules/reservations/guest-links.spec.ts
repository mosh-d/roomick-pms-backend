import { manageBookingLine } from './guest-links';

describe('manageBookingLine', () => {
  const original = process.env.PUBLIC_WEB_BASE_URL;
  afterEach(() => {
    process.env.PUBLIC_WEB_BASE_URL = original;
  });

  it('links to the branch’s own Manage your booking page, carrying the confirmation number only', () => {
    process.env.PUBLIC_WEB_BASE_URL = 'https://app.roomick.example/';
    expect(manageBookingLine({ bookingEngineEnabled: true, bookingSlug: 'lekki-suites' }, 'RES-2026-00001')).toBe(
      '\n\nManage your booking: https://app.roomick.example/book/lekki-suites/manage?confirmation=RES-2026-00001',
    );
  });

  it('adds nothing when the branch has no booking pages', () => {
    expect(manageBookingLine({ bookingEngineEnabled: false, bookingSlug: 'lekki-suites' }, 'RES-1')).toBe('');
    expect(manageBookingLine({ bookingEngineEnabled: true, bookingSlug: null }, 'RES-1')).toBe('');
  });
});
