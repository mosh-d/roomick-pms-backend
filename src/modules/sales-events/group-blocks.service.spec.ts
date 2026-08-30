import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';
import { GroupBlocksService } from './group-blocks.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

describe('GroupBlocksService', () => {
  let service: GroupBlocksService;
  let tx: {
    groupBlock: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
    reservation: { groupBy: jest.Mock; count: jest.Mock; update: jest.Mock };
  };
  let prisma: { withTenant: jest.Mock };
  let reservationsService: { createReservation: jest.Mock; setRateOverride: jest.Mock };

  beforeEach(async () => {
    tx = {
      groupBlock: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), update: jest.fn() },
      reservation: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), update: jest.fn() },
    };
    prisma = { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) };
    reservationsService = { createReservation: jest.fn(), setRateOverride: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [GroupBlocksService, { provide: PrismaService, useValue: prisma }, { provide: ReservationsService, useValue: reservationsService }],
    }).compile();
    service = moduleRef.get(GroupBlocksService);
  });

  describe('createBlock', () => {
    it('creates the block and reports zero pickup', async () => {
      tx.groupBlock.create.mockResolvedValue({ id: 'block-1', name: 'Acme Conf', roomTypeId: 'rt-1', blockSize: 20, blockRate: new Prisma.Decimal('45000'), cutoffDate: new Date('2026-10-01'), status: 'active', createdAt: new Date(), roomType: { name: 'Standard' } });
      const result = await service.createBlock(TENANT_ID, BRANCH_ID, { name: 'Acme Conf', roomTypeId: 'rt-1', blockSize: 20, blockRate: 45000, cutoffDate: '2026-10-01' }, ACTOR);
      expect(result.pickup).toBe(0);
      expect(result.blockRate).toBe('45000.00');
      expect(result.roomTypeName).toBe('Standard');
    });
  });

  describe('listBlocks', () => {
    it('computes pickup per block from real, currently-open reservations', async () => {
      tx.groupBlock.findMany.mockResolvedValue([
        { id: 'block-1', name: 'A', roomTypeId: 'rt-1', blockSize: 10, blockRate: new Prisma.Decimal('1000'), cutoffDate: new Date(), status: 'active', createdAt: new Date(), roomType: { name: 'Standard' } },
        { id: 'block-2', name: 'B', roomTypeId: 'rt-1', blockSize: 5, blockRate: new Prisma.Decimal('1000'), cutoffDate: new Date(), status: 'active', createdAt: new Date(), roomType: { name: 'Standard' } },
      ]);
      tx.reservation.groupBy.mockResolvedValue([{ groupBlockId: 'block-1', _count: { _all: 3 } }]);
      const result = await service.listBlocks(TENANT_ID, BRANCH_ID);
      expect(result.find((b) => b.id === 'block-1')?.pickup).toBe(3);
      expect(result.find((b) => b.id === 'block-2')?.pickup).toBe(0);
    });

    it('returns an empty array without querying pickup when there are no blocks', async () => {
      const result = await service.listBlocks(TENANT_ID, BRANCH_ID);
      expect(result).toEqual([]);
      expect(tx.reservation.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('releaseBlock', () => {
    it('throws NOT_FOUND for an unknown block', async () => {
      tx.groupBlock.findFirst.mockResolvedValue(null);
      await expect(service.releaseBlock(TENANT_ID, 'nonexistent')).rejects.toMatchObject({ status: 404 });
    });

    it('sets status to released without touching already-booked reservations', async () => {
      tx.groupBlock.findFirst.mockResolvedValue({ id: 'block-1' });
      tx.groupBlock.update.mockResolvedValue({ id: 'block-1', name: 'A', roomTypeId: 'rt-1', blockSize: 10, blockRate: new Prisma.Decimal('1000'), cutoffDate: new Date(), status: 'released', createdAt: new Date(), roomType: { name: 'Standard' } });
      tx.reservation.count.mockResolvedValue(4);
      const result = await service.releaseBlock(TENANT_ID, 'block-1');
      expect(result.status).toBe('released');
      expect(result.pickup).toBe(4);
    });
  });

  describe('bookIntoBlock', () => {
    const bookDto = { checkInDate: '2026-10-05', checkOutDate: '2026-10-08', adults: 2, guest: { name: 'Jane' } };

    it('throws NOT_FOUND for an unknown block', async () => {
      tx.groupBlock.findFirst.mockResolvedValue(null);
      await expect(service.bookIntoBlock(TENANT_ID, 'nonexistent', bookDto, ACTOR)).rejects.toMatchObject({ status: 404 });
    });

    it('rejects booking into a released/cancelled block', async () => {
      tx.groupBlock.findFirst.mockResolvedValue({ id: 'block-1', status: 'released', blockSize: 10, blockRate: new Prisma.Decimal('1000'), roomTypeId: 'rt-1', branchId: BRANCH_ID, name: 'A' });
      await expect(service.bookIntoBlock(TENANT_ID, 'block-1', bookDto, ACTOR)).rejects.toMatchObject({ status: 409 });
      expect(reservationsService.createReservation).not.toHaveBeenCalled();
    });

    it('rejects once the full allotment is already booked', async () => {
      tx.groupBlock.findFirst.mockResolvedValue({ id: 'block-1', status: 'active', blockSize: 2, blockRate: new Prisma.Decimal('1000'), roomTypeId: 'rt-1', branchId: BRANCH_ID, name: 'A' });
      tx.reservation.count.mockResolvedValue(2);
      await expect(service.bookIntoBlock(TENANT_ID, 'block-1', bookDto, ACTOR)).rejects.toMatchObject({ status: 409 });
      expect(reservationsService.createReservation).not.toHaveBeenCalled();
    });

    it('creates the reservation through ReservationsService, applies the block rate via setRateOverride, and links groupBlockId', async () => {
      tx.groupBlock.findFirst.mockResolvedValue({ id: 'block-1', status: 'active', blockSize: 10, blockRate: new Prisma.Decimal('45000'), roomTypeId: 'rt-1', branchId: BRANCH_ID, name: 'Acme Conf' });
      tx.reservation.count.mockResolvedValue(3);
      reservationsService.createReservation.mockResolvedValue({ id: 'res-1', confirmationNumber: 'RES-1' });

      const result = await service.bookIntoBlock(TENANT_ID, 'block-1', bookDto, ACTOR);

      expect(reservationsService.createReservation).toHaveBeenCalledWith(TENANT_ID, BRANCH_ID, expect.objectContaining({ roomTypeId: 'rt-1', checkInDate: bookDto.checkInDate }), ACTOR);
      expect(reservationsService.setRateOverride).toHaveBeenCalledWith(TENANT_ID, 'res-1', { overrideRate: 45000, reason: 'Group block: Acme Conf' }, ACTOR);
      expect(tx.reservation.update).toHaveBeenCalledWith({ where: { id: 'res-1' }, data: { groupBlockId: 'block-1' } });
      expect(result).toEqual({ reservationId: 'res-1', confirmationNumber: 'RES-1' });
    });
  });
});
