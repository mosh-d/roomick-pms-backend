import { Prisma } from '@prisma/client';
import { resolveStayFeePolicy, stayFeesFor } from './stay-fees';

const D = (value: string | number) => new Prisma.Decimal(value);
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
/** Check-out at 11:00 in Lagos (UTC+1) — 10:00 UTC. */
const branch = { timezone: 'Africa/Lagos', checkOutTime: new Date('1970-01-01T11:00:00.000Z') };

/** Four nights from the 10th: ₦20,000 a night, the Friday (13th) ₦30,000. */
const stay = {
  checkInDate: day('2026-11-10'),
  checkOutDate: day('2026-11-14'),
  confirmedRate: D('90000'),
  overrideRate: null,
  nightlyRates: [
    { date: '2026-11-10', rate: '20000.00' },
    { date: '2026-11-11', rate: '20000.00' },
    { date: '2026-11-12', rate: '20000.00' },
    { date: '2026-11-13', rate: '30000.00' },
  ],
};

describe('resolveStayFeePolicy', () => {
  it('charges nothing without a policy, or with an unusable one', () => {
    expect(resolveStayFeePolicy(null)).toEqual({ lateCheckout: null, earlyDeparture: null });
    expect(resolveStayFeePolicy({ lateCheckout: { feeType: 'percent_of_night', amount: 250 }, earlyDeparture: { feeType: 'flat', amount: 0 } })).toEqual({
      lateCheckout: null,
      earlyDeparture: null,
    });
  });

  it('reads a first-night early departure without an amount', () => {
    expect(resolveStayFeePolicy({ earlyDeparture: { feeType: 'first_night' } }).earlyDeparture).toEqual({ feeType: 'first_night', amount: null });
  });
});

describe('stayFeesFor', () => {
  const late = resolveStayFeePolicy({ lateCheckout: { feeType: 'percent_of_night', amount: 50, graceMinutes: 30 } });
  const flatLate = resolveStayFeePolicy({ lateCheckout: { feeType: 'flat', amount: 5000, graceMinutes: 0 } });

  it('late check-out: half the last night, once the grace after 11:00 has passed', () => {
    // 11:20 Lagos — inside the 30-minute grace.
    expect(stayFeesFor(late, stay, branch, day('2026-11-14'), new Date('2026-11-14T10:20:00.000Z'))).toEqual([]);
    // 11:45 Lagos — past it: half of Friday's ₦30,000.
    const fees = stayFeesFor(late, stay, branch, day('2026-11-14'), new Date('2026-11-14T10:45:00.000Z'));
    expect(fees).toEqual([{ kind: 'late_checkout', amount: D('15000'), description: 'Late check-out fee' }]);
  });

  it('late check-out: a flat fee', () => {
    expect(stayFeesFor(flatLate, stay, branch, day('2026-11-14'), new Date('2026-11-14T10:01:00.000Z'))[0].amount.toFixed(2)).toBe('5000.00');
  });

  it('no late fee before the last day', () => {
    expect(stayFeesFor(flatLate, stay, branch, day('2026-11-13'), new Date('2026-11-13T16:00:00.000Z'))).toEqual([]);
  });

  it('early departure: flat, the first night given up, or a share of every night given up', () => {
    const today = day('2026-11-12');
    const now = new Date('2026-11-12T08:00:00.000Z');
    expect(stayFeesFor(resolveStayFeePolicy({ earlyDeparture: { feeType: 'flat', amount: 7500 } }), stay, branch, today, now)).toEqual([
      { kind: 'early_departure', amount: D('7500'), description: 'Early departure fee (2 nights given up)' },
    ]);
    expect(stayFeesFor(resolveStayFeePolicy({ earlyDeparture: { feeType: 'first_night' } }), stay, branch, today, now)[0].amount.toFixed(2)).toBe('20000.00');
    // Thursday ₦20,000 + Friday ₦30,000, half of it.
    expect(stayFeesFor(resolveStayFeePolicy({ earlyDeparture: { feeType: 'percent_of_remaining', amount: 50 } }), stay, branch, today, now)[0].amount.toFixed(2)).toBe('25000.00');
  });

  it('no early departure fee on the booked last day', () => {
    expect(stayFeesFor(resolveStayFeePolicy({ earlyDeparture: { feeType: 'flat', amount: 7500 } }), stay, branch, day('2026-11-14'), new Date('2026-11-14T08:00:00.000Z'))).toEqual([]);
  });

  it('a manager’s override rate prices the nights', () => {
    const fees = stayFeesFor(resolveStayFeePolicy({ earlyDeparture: { feeType: 'first_night' } }), { ...stay, overrideRate: D('12000') }, branch, day('2026-11-12'), new Date('2026-11-12T08:00:00.000Z'));
    expect(fees[0].amount.toFixed(2)).toBe('12000.00');
  });
});
