import { branchCutoffInstant, hasPassedBranchCutoff, timeOfDay, toBranchDate } from './branch-date';

describe('timeOfDay', () => {
  it('extracts HH:MM:SS from a Branch.checkInTime/checkOutTime value, regardless of its date component', () => {
    expect(timeOfDay(new Date('1970-01-01T11:00:00.000Z'))).toBe('11:00:00');
    expect(timeOfDay(new Date('1970-01-01T14:30:05.000Z'))).toBe('14:30:05');
  });
});

describe('branchCutoffInstant', () => {
  it('computes the correct UTC instant for a no-DST, positive-offset timezone (Africa/Lagos, UTC+1)', () => {
    expect(branchCutoffInstant(toBranchDate('2026-08-29'), '11:00:00', 'Africa/Lagos').toISOString()).toBe('2026-08-29T10:00:00.000Z');
  });

  it('computes the correct UTC instant for a DST-observing timezone (America/New_York, UTC-4 in August)', () => {
    expect(branchCutoffInstant(toBranchDate('2026-08-29'), '11:00:00', 'America/New_York').toISOString()).toBe('2026-08-29T15:00:00.000Z');
  });

  it('computes the correct UTC instant for a positive-offset Asian timezone (Asia/Tokyo, UTC+9, no DST)', () => {
    expect(branchCutoffInstant(toBranchDate('2026-08-29'), '11:00:00', 'Asia/Tokyo').toISOString()).toBe('2026-08-29T02:00:00.000Z');
  });

  it('handles midnight-crossing correctly — a late checkout time in a negative-offset zone can land on the previous UTC day', () => {
    // 23:00 in Los Angeles (UTC-7 in August) on the 29th is 06:00 UTC on the 30th, not the 29th.
    expect(branchCutoffInstant(toBranchDate('2026-08-29'), '23:00:00', 'America/Los_Angeles').toISOString()).toBe('2026-08-30T06:00:00.000Z');
  });
});

describe('hasPassedBranchCutoff', () => {
  it('is false before the cutoff instant', () => {
    const now = new Date('2026-08-29T09:59:59.000Z');
    expect(hasPassedBranchCutoff(toBranchDate('2026-08-29'), '11:00:00', 'Africa/Lagos', now)).toBe(false);
  });

  it('is true exactly at, and after, the cutoff instant', () => {
    expect(hasPassedBranchCutoff(toBranchDate('2026-08-29'), '11:00:00', 'Africa/Lagos', new Date('2026-08-29T10:00:00.000Z'))).toBe(true);
    expect(hasPassedBranchCutoff(toBranchDate('2026-08-29'), '11:00:00', 'Africa/Lagos', new Date('2026-08-29T10:00:01.000Z'))).toBe(true);
  });

  it('is true for any date strictly before today, regardless of clock time', () => {
    expect(hasPassedBranchCutoff(toBranchDate('2026-08-20'), '11:00:00', 'Africa/Lagos', new Date('2026-08-29T00:00:01.000Z'))).toBe(true);
  });
});
