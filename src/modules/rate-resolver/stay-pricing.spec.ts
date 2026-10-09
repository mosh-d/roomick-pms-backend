import { Prisma } from '@prisma/client';
import { dayUseHoursFor } from '../reservations/day-use';
import { chargePerPosting, packageTotal, parsePackageSnapshots, PackageSnapshot, postingsFor } from './package-pricing';
import { occupancySurcharge } from './rate-resolver.service';

const D = (value: string | number) => new Prisma.Decimal(value);

describe('occupancySurcharge', () => {
  const roomType = { adultsIncluded: 2, extraAdultRate: D('10000'), childrenIncluded: 1, childRate: D('4000') };

  it('charges each adult over those included, and each child over those who stay free', () => {
    expect(occupancySurcharge(roomType, { adults: 2, children: 1 }).toFixed(2)).toBe('0.00');
    expect(occupancySurcharge(roomType, { adults: 3, children: 1 }).toFixed(2)).toBe('10000.00');
    expect(occupancySurcharge(roomType, { adults: 4, children: 3 }).toFixed(2)).toBe('28000.00');
  });

  it('charges nothing the room type doesn’t ask for, or when nobody says who is staying', () => {
    expect(occupancySurcharge({ adultsIncluded: null, extraAdultRate: D('10000'), childrenIncluded: 0, childRate: null }, { adults: 4, children: 2 }).toFixed(2)).toBe('0.00');
    expect(occupancySurcharge(roomType, undefined).toFixed(2)).toBe('0.00');
  });
});

describe('package pricing', () => {
  const breakfast: PackageSnapshot = { packageId: 'p1', name: 'Breakfast', price: '5000.00', basis: 'per_person_per_night', chargeType: 'fnb' };
  const transfer: PackageSnapshot = { packageId: 'p2', name: 'Airport pick-up', price: '15000.00', basis: 'per_stay', chargeType: 'transport' };
  const parking: PackageSnapshot = { packageId: 'p3', name: 'Parking', price: '2000.00', basis: 'per_night', chargeType: 'misc' };

  it('prices a night per guest, a night, or the stay once', () => {
    expect(chargePerPosting(breakfast, 3).toFixed(2)).toBe('15000.00');
    expect(postingsFor(breakfast, 4)).toBe(4);
    expect(packageTotal(breakfast, 4, 3).toFixed(2)).toBe('60000.00');
    expect(packageTotal(parking, 4, 3).toFixed(2)).toBe('8000.00');
    expect(postingsFor(transfer, 4)).toBe(1);
    expect(packageTotal(transfer, 4, 3).toFixed(2)).toBe('15000.00');
  });

  it('reads a stay’s snapshots, dropping anything malformed', () => {
    expect(parsePackageSnapshots([breakfast, { name: 'no id' }, 'x'] as unknown as Prisma.JsonValue)).toEqual([breakfast]);
    expect(parsePackageSnapshots(null)).toEqual([]);
  });
});

describe('dayUseHoursFor', () => {
  it('reads good hours and refuses anything else', () => {
    expect(dayUseHoursFor({ from: '10:00', until: '17:00' })).toEqual({ from: '10:00', until: '17:00' });
    expect(dayUseHoursFor({ from: '17:00', until: '10:00' })).toBeNull();
    expect(dayUseHoursFor({ from: '25:00', until: '26:00' })).toBeNull();
    expect(dayUseHoursFor(null)).toBeNull();
  });
});
