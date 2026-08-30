import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RestrictionsService } from './restrictions.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const ROOM_TYPE_ID = '33333333-3333-4333-8333-333333333333';

describe('RestrictionsService', () => {
  let service: RestrictionsService;
  let tx: { availabilityRestriction: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock; delete: jest.Mock } };
  let prisma: { withTenant: jest.Mock };

  beforeEach(async () => {
    tx = { availabilityRestriction: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), delete: jest.fn() } };
    prisma = { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) };
    const moduleRef = await Test.createTestingModule({ providers: [RestrictionsService, { provide: PrismaService, useValue: prisma }] }).compile();
    service = moduleRef.get(RestrictionsService);
  });

  describe('deleteRestriction', () => {
    it('throws NOT_FOUND for an unknown restriction', async () => {
      tx.availabilityRestriction.findFirst.mockResolvedValue(null);
      await expect(service.deleteRestriction(TENANT_ID, 'nonexistent')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('assertNoViolation', () => {
    const checkIn = new Date('2026-12-24T00:00:00.000Z');
    const checkOut = new Date('2026-12-27T00:00:00.000Z'); // 3 nights

    it('does nothing when no restriction overlaps the stay', async () => {
      tx.availabilityRestriction.findMany.mockResolvedValue([]);
      await expect(service.assertNoViolation(tx as never, BRANCH_ID, ROOM_TYPE_ID, checkIn, checkOut)).resolves.toBeUndefined();
    });

    it('rejects any booking at all when stopSell is set', async () => {
      tx.availabilityRestriction.findMany.mockResolvedValue([{ stopSell: true, closedToArrival: false, minLOS: null, maxLOS: null, startDate: checkIn, endDate: checkOut }]);
      await expect(service.assertNoViolation(tx as never, BRANCH_ID, ROOM_TYPE_ID, checkIn, checkOut)).rejects.toMatchObject({ status: 409 });
    });

    it('rejects an arrival that falls within a closed-to-arrival window', async () => {
      tx.availabilityRestriction.findMany.mockResolvedValue([{ stopSell: false, closedToArrival: true, minLOS: null, maxLOS: null, startDate: checkIn, endDate: checkOut }]);
      await expect(service.assertNoViolation(tx as never, BRANCH_ID, ROOM_TYPE_ID, checkIn, checkOut)).rejects.toMatchObject({ status: 409 });
    });

    it('does NOT reject closed-to-arrival when the check-in date is outside that specific window', async () => {
      const laterCheckIn = new Date('2026-12-28T00:00:00.000Z');
      const laterCheckOut = new Date('2026-12-30T00:00:00.000Z');
      tx.availabilityRestriction.findMany.mockResolvedValue([{ stopSell: false, closedToArrival: true, minLOS: null, maxLOS: null, startDate: checkIn, endDate: checkOut }]);
      await expect(service.assertNoViolation(tx as never, BRANCH_ID, ROOM_TYPE_ID, laterCheckIn, laterCheckOut)).resolves.toBeUndefined();
    });

    it('rejects a stay shorter than minLOS', async () => {
      tx.availabilityRestriction.findMany.mockResolvedValue([{ stopSell: false, closedToArrival: false, minLOS: 5, maxLOS: null, startDate: checkIn, endDate: checkOut }]);
      await expect(service.assertNoViolation(tx as never, BRANCH_ID, ROOM_TYPE_ID, checkIn, checkOut)).rejects.toMatchObject({ status: 409 });
    });

    it('allows a stay meeting minLOS exactly', async () => {
      tx.availabilityRestriction.findMany.mockResolvedValue([{ stopSell: false, closedToArrival: false, minLOS: 3, maxLOS: null, startDate: checkIn, endDate: checkOut }]);
      await expect(service.assertNoViolation(tx as never, BRANCH_ID, ROOM_TYPE_ID, checkIn, checkOut)).resolves.toBeUndefined();
    });

    it('rejects a stay longer than maxLOS', async () => {
      tx.availabilityRestriction.findMany.mockResolvedValue([{ stopSell: false, closedToArrival: false, minLOS: null, maxLOS: 2, startDate: checkIn, endDate: checkOut }]);
      await expect(service.assertNoViolation(tx as never, BRANCH_ID, ROOM_TYPE_ID, checkIn, checkOut)).rejects.toMatchObject({ status: 409 });
    });

    it('queries restrictions scoped to this room type OR the branch-wide (null roomTypeId) ones', async () => {
      await service.assertNoViolation(tx as never, BRANCH_ID, ROOM_TYPE_ID, checkIn, checkOut);
      expect(tx.availabilityRestriction.findMany).toHaveBeenCalledWith({
        where: { branchId: BRANCH_ID, OR: [{ roomTypeId: null }, { roomTypeId: ROOM_TYPE_ID }], startDate: { lt: checkOut }, endDate: { gt: checkIn } },
      });
    });
  });
});
