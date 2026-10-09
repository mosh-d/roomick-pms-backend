import { Prisma } from '@prisma/client';
import { depositFor, describeDeposit, resolveDepositPolicy } from './deposits';

const D = (value: string | number) => new Prisma.Decimal(value);
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** Three nights, ₦20,000 + ₦20,000 + ₦26,000 = ₦66,000, with 7.5% VAT on top = ₦70,950. */
const stay = { checkInDate: day('2026-11-20'), subtotal: D('66000'), totalWithTax: D('70950'), firstNight: D('20000') };

describe('resolveDepositPolicy', () => {
  it('asks for nothing without a usable policy', () => {
    expect(resolveDepositPolicy(null)).toBeNull();
    expect(resolveDepositPolicy({ type: 'none', value: null, dueDaysBeforeArrival: 3 })).toBeNull();
    expect(resolveDepositPolicy({ type: 'percentage', value: null, dueDaysBeforeArrival: 3 })).toBeNull();
    expect(resolveDepositPolicy({ type: 'percentage', value: 150, dueDaysBeforeArrival: 3 })).toBeNull();
    expect(resolveDepositPolicy({ type: 'fixed', value: -5, dueDaysBeforeArrival: 3 })).toBeNull();
    expect(resolveDepositPolicy({ type: 'wire', value: 10, dueDaysBeforeArrival: 3 })).toBeNull();
    expect(resolveDepositPolicy([1, 2])).toBeNull();
  });

  it('reads a good policy, with a missing due date meaning by arrival', () => {
    expect(resolveDepositPolicy({ type: 'first_night', value: null })).toEqual({ type: 'first_night', value: null, dueDaysBeforeArrival: 0 });
    expect(resolveDepositPolicy({ type: 'percentage', value: 30, dueDaysBeforeArrival: 7 })).toEqual({ type: 'percentage', value: 30, dueDaysBeforeArrival: 7 });
  });
});

describe('depositFor', () => {
  const booked = day('2026-10-01');

  it('first night: the first night with its share of the tax', () => {
    const deposit = depositFor({ type: 'first_night', value: null, dueDaysBeforeArrival: 0 }, stay, booked);
    expect(deposit?.amount.toFixed(2)).toBe('21500.00');
    expect(deposit?.dueDate).toEqual(day('2026-11-20'));
  });

  it('percentage of the stay, tax included', () => {
    expect(depositFor({ type: 'percentage', value: 30, dueDaysBeforeArrival: 7 }, stay, booked)?.amount.toFixed(2)).toBe('21285.00');
  });

  it('a fixed amount, never more than the stay', () => {
    expect(depositFor({ type: 'fixed', value: 10000, dueDaysBeforeArrival: 0 }, stay, booked)?.amount.toFixed(2)).toBe('10000.00');
    expect(depositFor({ type: 'fixed', value: 900000, dueDaysBeforeArrival: 0 }, stay, booked)?.amount.toFixed(2)).toBe('70950.00');
  });

  it('due the set number of days before arrival — or straight away for a booking made closer in', () => {
    expect(depositFor({ type: 'fixed', value: 5000, dueDaysBeforeArrival: 7 }, stay, booked)?.dueDate).toEqual(day('2026-11-13'));
    expect(depositFor({ type: 'fixed', value: 5000, dueDaysBeforeArrival: 7 }, stay, day('2026-11-18'))?.dueDate).toEqual(day('2026-11-18'));
  });

  it('asks for nothing with no policy, or a stay worth nothing', () => {
    expect(depositFor(null, stay, booked)).toBeNull();
    expect(depositFor({ type: 'percentage', value: 30, dueDaysBeforeArrival: 0 }, { ...stay, subtotal: D(0), totalWithTax: D(0), firstNight: D(0) }, booked)).toBeNull();
  });

  it('says what is due and by when', () => {
    expect(describeDeposit(D('21500'), day('2026-11-13'), 'NGN')).toBe('A deposit of NGN 21500.00 is due by 13 Nov 2026.');
  });
});
