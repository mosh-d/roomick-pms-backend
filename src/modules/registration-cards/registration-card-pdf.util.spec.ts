import { stayNights } from './registration-card-pdf.util';

describe('registration card PDF', () => {
  it('counts the nights the card’s rate covers from its own dates — the rate is the stay’s total, not a nightly price', () => {
    expect(stayNights({ checkInDate: '2026-09-01', checkOutDate: '2026-09-04' })).toBe(3);
    expect(stayNights({ checkInDate: '2026-10-25', checkOutDate: '2026-10-26' })).toBe(1);
  });
});
