import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { ReportsService } from './reports.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const TYPE_A = '66666666-6666-4666-8666-666666666666';
const TYPE_B = '77777777-7777-4777-8777-777777777777';

function makeTx() {
  return {
    roomType: { findMany: jest.fn().mockResolvedValue([{ id: TYPE_A, name: 'Standard' }, { id: TYPE_B, name: 'Deluxe' }]) },
    room: { count: jest.fn().mockResolvedValue(0) },
    reservation: { findMany: jest.fn().mockResolvedValue([]) },
    lineItem: { findMany: jest.fn().mockResolvedValue([]) },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('ReportsService', () => {
  let service: ReportsService;
  let tx: ReturnType<typeof makeTx>;
  let propertyService: { assertBranch: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    propertyService = { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, currency: 'NGN' }) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: PropertyService, useValue: propertyService },
      ],
    }).compile();
    service = moduleRef.get(ReportsService);
  });

  describe('getOccupancy', () => {
    it('computes occupancy% from physical pool vs. overlapping reservations, 2 nights x 2 room types', async () => {
      tx.room.count.mockImplementation(({ where }: { where: { roomTypeId: string } }) => Promise.resolve(where.roomTypeId === TYPE_A ? 4 : 2));
      // Type A: 1 reservation covering both nights. Type B: 1 reservation covering only the first night.
      tx.reservation.findMany.mockResolvedValue([
        { roomTypeId: TYPE_A, checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-03T00:00:00.000Z') },
        { roomTypeId: TYPE_B, checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
      ]);

      const result = await service.getOccupancy(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-03' });

      // Available: (4+2) rooms x 2 nights = 12. Sold: TypeA 2 nights + TypeB 1 night = 3.
      expect(result.summary.roomNightsAvailable).toBe(12);
      expect(result.summary.roomNightsSold).toBe(3);
      expect(result.summary.occupancyPct).toBe(25);

      const typeA = result.byRoomType.find((r) => r.roomTypeId === TYPE_A);
      expect(typeA).toEqual({ roomTypeId: TYPE_A, roomTypeName: 'Standard', roomNightsAvailable: 8, roomNightsSold: 2, occupancyPct: 25 });
      const typeB = result.byRoomType.find((r) => r.roomTypeId === TYPE_B);
      expect(typeB).toEqual({ roomTypeId: TYPE_B, roomTypeName: 'Deluxe', roomNightsAvailable: 4, roomNightsSold: 1, occupancyPct: 25 });
    });

    it('groupBy=month buckets every day in the range into one calendar-month trend row', async () => {
      tx.room.count.mockResolvedValue(1);
      const result = await service.getOccupancy(TENANT_ID, BRANCH_ID, { from: '2026-09-28', to: '2026-10-03', groupBy: 'month' });
      expect(result.trend.map((t) => t.period)).toEqual(['2026-09', '2026-10']);
    });

    it('groupBy=day (default) produces one trend row per night', async () => {
      tx.room.count.mockResolvedValue(1);
      const result = await service.getOccupancy(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-04' });
      expect(result.trend.map((t) => t.period)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    });

    it('a room type with zero pool reports 0% occupancy, not a division-by-zero crash', async () => {
      tx.room.count.mockResolvedValue(0);
      const result = await service.getOccupancy(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02' });
      expect(result.summary.occupancyPct).toBe(0);
    });

    it('restricts to a single room type when roomTypeId is given', async () => {
      tx.roomType.findMany.mockResolvedValue([{ id: TYPE_A, name: 'Standard' }]);
      tx.room.count.mockResolvedValue(3);
      const result = await service.getOccupancy(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02', roomTypeId: TYPE_A });
      expect(result.byRoomType).toHaveLength(1);
      expect(tx.roomType.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: TYPE_A }) }));
    });
  });

  describe('getAdr', () => {
    it('derives ADR as room revenue / room-nights sold, per room type and overall', async () => {
      tx.room.count.mockResolvedValue(5);
      tx.reservation.findMany.mockResolvedValue([
        { roomTypeId: TYPE_A, checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
      ]);
      tx.lineItem.findMany.mockResolvedValue([
        { amount: new Prisma.Decimal('150.00'), serviceDate: new Date('2026-09-01T00:00:00.000Z'), folio: { reservation: { roomTypeId: TYPE_A } } },
      ]);
      const result = await service.getAdr(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02' });
      const typeA = result.byRoomType.find((r) => r.roomTypeId === TYPE_A);
      expect(typeA?.roomRevenue).toBe('150.00');
      expect(typeA?.adr).toBe('150.00'); // 1 night sold
      expect(result.summary.adr).toBe('150.00');
    });

    it('zero nights sold reports adr "0.00", not a crash', async () => {
      tx.room.count.mockResolvedValue(2);
      const result = await service.getAdr(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02' });
      expect(result.summary.adr).toBe('0.00');
    });
  });

  describe('getRevpar', () => {
    it('derives RevPAR as room revenue / room-nights AVAILABLE (not sold) — the whole point of the metric', async () => {
      tx.room.count.mockResolvedValue(4); // 4 rooms x 1 night = 4 available
      tx.lineItem.findMany.mockResolvedValue([
        { amount: new Prisma.Decimal('200.00'), serviceDate: new Date('2026-09-01T00:00:00.000Z'), folio: { reservation: { roomTypeId: TYPE_A } } },
      ]);
      const result = await service.getRevpar(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02' });
      // Both room types pooled: 4+4=8 available, revenue only 200 (TypeA only).
      expect(result.summary.roomNightsAvailable).toBe(8);
      expect(result.summary.roomRevenue).toBe('200.00');
      expect(result.summary.revpar).toBe('25.00');
    });
  });

  describe('getRevenue', () => {
    it('groups by chargeType, excluding tax and correction rows', async () => {
      tx.lineItem.findMany.mockResolvedValue([
        { amount: new Prisma.Decimal('300.00'), chargeType: 'room', serviceDate: new Date('2026-09-01') },
        { amount: new Prisma.Decimal('50.00'), chargeType: 'fnb', serviceDate: new Date('2026-09-01') },
      ]);
      const result = await service.getRevenue(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02' });
      expect(result.byDepartment).toEqual(expect.arrayContaining([{ chargeType: 'room', amount: '300.00' }, { chargeType: 'fnb', amount: '50.00' }]));
      expect(result.summary.totalRevenue).toBe('350.00');
      // The query itself must never even ask for tax/correction rows.
      expect(tx.lineItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ chargeType: { notIn: ['tax', 'correction'] } }) }));
    });

    it('nets refunds (negative payment amounts) into the same payment-method total', async () => {
      tx.payment.findMany.mockResolvedValue([
        { amount: new Prisma.Decimal('500.00'), method: 'cash' },
        { amount: new Prisma.Decimal('-100.00'), method: 'cash' },
      ]);
      const result = await service.getRevenue(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02' });
      expect(result.byPaymentMethod).toEqual([{ method: 'cash', amount: '400.00' }]);
    });

    it('produces a day-level trend keyed by serviceDate', async () => {
      tx.lineItem.findMany.mockResolvedValue([
        { amount: new Prisma.Decimal('100.00'), chargeType: 'room', serviceDate: new Date('2026-09-01') },
        { amount: new Prisma.Decimal('200.00'), chargeType: 'room', serviceDate: new Date('2026-09-02') },
      ]);
      const result = await service.getRevenue(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-03' });
      expect(result.trend).toEqual([{ period: '2026-09-01', amount: '100.00' }, { period: '2026-09-02', amount: '200.00' }]);
    });
  });
});
