import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';
import { GroupBlocksService } from './group-blocks.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_BRANCH_ID = '99999999-9999-4999-8999-999999999999';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';

function actor(role = 'manager', branchId: string | null = BRANCH_ID): JwtPayload {
  return { sub: ACTOR_ID, tenantId: TENANT_ID, email: 'sales@example.com', roles: [{ branchId, role }], tokenType: 'access' };
}

/** `YYYY-MM-DD`, `days` from today (UTC) — the service reads the real clock in the branch's timezone. */
function day(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function block(overrides: Record<string, unknown> = {}) {
  return {
    id: 'block-1',
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    roomTypeId: 'rt-1',
    name: 'Acme Conf',
    blockSize: 10,
    blockRate: new Prisma.Decimal('45000'),
    arrivalDate: new Date(`${day(30)}T00:00:00.000Z`),
    departureDate: new Date(`${day(33)}T00:00:00.000Z`),
    cutoffDate: new Date(`${day(20)}T00:00:00.000Z`),
    status: 'active',
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    createdAt: new Date(),
    createdBy: ACTOR_ID,
    roomType: { name: 'Standard' },
    ...overrides,
  };
}

type Data = { data: Record<string, unknown> };

describe('GroupBlocksService', () => {
  let service: GroupBlocksService;
  let tx: ReturnType<typeof makeTx>;
  let reservationsService: { createReservation: jest.Mock; availabilityPerNightInTx: jest.Mock };

  function makeTx() {
    return {
      $queryRaw: jest.fn().mockResolvedValue([]),
      groupBlock: {
        create: jest.fn().mockImplementation(({ data }: Data) => Promise.resolve(block({ ...data }))),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(block()),
        update: jest.fn().mockImplementation(({ data }: Data) => Promise.resolve(block({ ...data }))),
      },
      roomType: { findFirst: jest.fn().mockResolvedValue({ id: 'rt-1', name: 'Standard' }) },
      reservation: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      branch: { findFirst: jest.fn().mockResolvedValue({ timezone: 'Africa/Lagos' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
  }

  beforeEach(async () => {
    tx = makeTx();
    reservationsService = {
      createReservation: jest.fn().mockImplementation((_t: string, _b: string, dto: { guest?: { name: string } }) =>
        Promise.resolve({ id: `res-${dto.guest?.name ?? 'x'}`, confirmationNumber: `RES-${dto.guest?.name ?? 'x'}` }),
      ),
      availabilityPerNightInTx: jest.fn().mockResolvedValue([{ date: day(30), available: 20 }]),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GroupBlocksService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: ReservationsService, useValue: reservationsService },
      ],
    }).compile();
    service = moduleRef.get(GroupBlocksService);
  });

  const createDto = (overrides: Record<string, unknown> = {}) => ({
    name: 'Acme Conf',
    roomTypeId: 'rt-1',
    blockSize: 10,
    blockRate: 45000,
    arrivalDate: day(30),
    departureDate: day(33),
    cutoffDate: day(20),
    ...overrides,
  });

  describe('createBlock', () => {
    it('refuses stay dates that end before they start, a cut-off after arrival, or one already past', async () => {
      await expect(service.createBlock(TENANT_ID, BRANCH_ID, createDto({ departureDate: day(30) }), ACTOR_ID)).rejects.toThrow(BadRequestException);
      await expect(service.createBlock(TENANT_ID, BRANCH_ID, createDto({ cutoffDate: day(31) }), ACTOR_ID)).rejects.toThrow(BadRequestException);
      await expect(service.createBlock(TENANT_ID, BRANCH_ID, createDto({ cutoffDate: day(-2) }), ACTOR_ID)).rejects.toThrow(BadRequestException);
      expect(tx.groupBlock.create).not.toHaveBeenCalled();
    });

    it('only holds rooms that are free on every night, checked under the room-type lock', async () => {
      reservationsService.availabilityPerNightInTx.mockResolvedValue([
        { date: day(30), available: 12 },
        { date: day(31), available: 6 },
      ]);
      await expect(service.createBlock(TENANT_ID, BRANCH_ID, createDto(), ACTOR_ID)).rejects.toThrow(/Only 6 Standard rooms are free on/);
      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(tx.groupBlock.create).not.toHaveBeenCalled();
    });

    it('creates the block with its stay, and it starts out holding its whole allotment', async () => {
      const result = await service.createBlock(TENANT_ID, BRANCH_ID, createDto({ contactName: ' Jane Smith ' }), ACTOR_ID);
      const data = (tx.groupBlock.create.mock.calls[0] as [Data])[0].data;
      expect((data.arrivalDate as Date).toISOString().slice(0, 10)).toBe(day(30));
      expect((data.departureDate as Date).toISOString().slice(0, 10)).toBe(day(33));
      expect(data.contactName).toBe('Jane Smith');
      expect(result).toMatchObject({ pickup: 0, holdState: 'holding', roomsHeld: 10, blockRate: '45000.00' });
    });

    it("refuses a room type that isn't at the branch", async () => {
      tx.roomType.findFirst.mockResolvedValue(null);
      await expect(service.createBlock(TENANT_ID, BRANCH_ID, createDto(), ACTOR_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('listBlocks', () => {
    it("reports each block's pickup and whether it is still holding rooms", async () => {
      tx.groupBlock.findMany.mockResolvedValue([
        block({ id: 'holding' }),
        block({ id: 'lapsed', cutoffDate: new Date(`${day(-1)}T00:00:00.000Z`) }),
        block({ id: 'released', status: 'released' }),
        block({ id: 'legacy', arrivalDate: null, departureDate: null }),
      ]);
      tx.reservation.groupBy.mockResolvedValue([{ groupBlockId: 'holding', _count: { _all: 3 } }]);
      const byId = Object.fromEntries((await service.listBlocks(TENANT_ID, BRANCH_ID)).map((b) => [b.id, b]));
      expect(byId.holding).toMatchObject({ holdState: 'holding', pickup: 3, roomsHeld: 7 });
      expect(byId.lapsed).toMatchObject({ holdState: 'lapsed', roomsHeld: 0 });
      expect(byId.released).toMatchObject({ holdState: 'released', roomsHeld: 0 });
      expect(byId.legacy).toMatchObject({ holdState: 'none', roomsHeld: 0 });
    });

    it('returns an empty array without querying pickup when there are no blocks', async () => {
      expect(await service.listBlocks(TENANT_ID, BRANCH_ID)).toEqual([]);
      expect(tx.reservation.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('releaseBlock', () => {
    it('throws NOT_FOUND for an unknown block', async () => {
      tx.groupBlock.findFirst.mockResolvedValue(null);
      await expect(service.releaseBlock(TENANT_ID, 'nonexistent', actor())).rejects.toThrow(NotFoundException);
    });

    it("checks the manager's role at the block's own branch", async () => {
      await expect(service.releaseBlock(TENANT_ID, 'block-1', actor('manager', OTHER_BRANCH_ID))).rejects.toThrow(ForbiddenException);
      expect(tx.groupBlock.update).not.toHaveBeenCalled();
    });

    it('stops holding at once, without touching the bookings already made', async () => {
      tx.reservation.count.mockResolvedValue(4);
      const result = await service.releaseBlock(TENANT_ID, 'block-1', actor());
      expect(tx.groupBlock.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'released' } }));
      expect(result).toMatchObject({ status: 'released', holdState: 'released', pickup: 4, roomsHeld: 0 });
    });

    it('refuses to release a block twice', async () => {
      tx.groupBlock.findFirst.mockResolvedValue(block({ status: 'released' }));
      await expect(service.releaseBlock(TENANT_ID, 'block-1', actor())).rejects.toThrow(ConflictException);
    });
  });

  describe('bookIntoBlock', () => {
    it('books through the ordinary reservation path, into the block, on its own dates by default', async () => {
      const result = await service.bookIntoBlock(TENANT_ID, 'block-1', { adults: 2, guest: { name: 'Jane' } }, actor('front_desk'));
      expect(reservationsService.createReservation).toHaveBeenCalledWith(
        TENANT_ID,
        BRANCH_ID,
        expect.objectContaining({ roomTypeId: 'rt-1', checkInDate: day(30), checkOutDate: day(33), adults: 2 }),
        ACTOR_ID,
        { groupBlockId: 'block-1' },
      );
      expect(result).toEqual({ reservationId: 'res-Jane', confirmationNumber: 'RES-Jane' });
    });

    it('takes stay dates given for an early arrival', async () => {
      await service.bookIntoBlock(TENANT_ID, 'block-1', { adults: 1, guest: { name: 'Early' }, checkInDate: day(29) }, actor());
      expect(reservationsService.createReservation.mock.calls[0][2]).toMatchObject({ checkInDate: day(29), checkOutDate: day(33) });
    });

    it('needs dates when the block has none of its own', async () => {
      tx.groupBlock.findFirst.mockResolvedValue(block({ arrivalDate: null, departureDate: null }));
      await expect(service.bookIntoBlock(TENANT_ID, 'block-1', { adults: 1, guest: { name: 'X' } }, actor())).rejects.toThrow(BadRequestException);
    });

    it('is for booking staff at the block’s branch', async () => {
      await expect(service.bookIntoBlock(TENANT_ID, 'block-1', { adults: 1, guest: { name: 'X' } }, actor('housekeeper'))).rejects.toThrow(ForbiddenException);
    });
  });

  describe('importRoomingList', () => {
    it('checks every row before booking any', async () => {
      const rows = [{ guestName: 'Ada' }, { guestName: 'Bola', checkInDate: day(33), checkOutDate: day(31) }];
      await expect(service.importRoomingList(TENANT_ID, 'block-1', { rows }, actor())).rejects.toThrow(/Nothing was booked\. Row 2: check-out must be after check-in/);
      expect(reservationsService.createReservation).not.toHaveBeenCalled();
    });

    it("refuses a list longer than the rooms the block has left", async () => {
      tx.reservation.count.mockResolvedValue(9);
      await expect(service.importRoomingList(TENANT_ID, 'block-1', { rows: [{ guestName: 'Ada' }, { guestName: 'Bola' }] }, actor())).rejects.toThrow(
        /has 1 of its 10 rooms left, and the list has 2 guests/,
      );
      expect(reservationsService.createReservation).not.toHaveBeenCalled();
    });

    it('books each guest into the block, and reports a refused row without stopping the rest', async () => {
      reservationsService.createReservation.mockImplementation((_t: string, _b: string, dto: { guest: { name: string } }) =>
        dto.guest.name === 'Chidi'
          ? Promise.reject(new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Standard sleeps up to 2 adult(s)' }))
          : Promise.resolve({ id: `res-${dto.guest.name}`, confirmationNumber: `RES-${dto.guest.name}` }),
      );
      const result = await service.importRoomingList(
        TENANT_ID,
        'block-1',
        { rows: [{ guestName: 'Ada', email: 'ada@example.com' }, { guestName: 'Chidi', adults: 4 }, { guestName: 'Bola', checkOutDate: day(32) }] },
        actor('front_desk'),
      );
      expect(result.created.map((c) => c.confirmationNumber)).toEqual(['RES-Ada', 'RES-Bola']);
      expect(result.failed).toEqual([{ row: 2, guestName: 'Chidi', message: 'Standard sleeps up to 2 adult(s)' }]);
      expect(reservationsService.createReservation.mock.calls[0][2]).toMatchObject({
        guest: { name: 'Ada', email: 'ada@example.com' },
        checkInDate: day(30),
        checkOutDate: day(33),
        adults: 1,
      });
      expect(reservationsService.createReservation.mock.calls[2][2]).toMatchObject({ checkOutDate: day(32) });
      expect(reservationsService.createReservation.mock.calls[0][4]).toEqual({ groupBlockId: 'block-1' });
    });

    it("won't import into a released block", async () => {
      tx.groupBlock.findFirst.mockResolvedValue(block({ status: 'released' }));
      await expect(service.importRoomingList(TENANT_ID, 'block-1', { rows: [{ guestName: 'Ada' }] }, actor())).rejects.toThrow(ConflictException);
    });
  });
});
