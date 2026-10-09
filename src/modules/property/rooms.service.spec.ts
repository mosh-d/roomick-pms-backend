import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from './property.service';
import { RoomsService } from './rooms.service';
import { ObjectStorageService } from '../../common/storage/object-storage.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = '77777777-7777-4777-8777-777777777777';
const TYPE_ID = '88888888-8888-4888-8888-888888888888';
const FLOOR_ID = '99999999-9999-4999-8999-999999999999';

const manager: JwtPayload = {
  sub: 'manager-id',
  tenantId: TENANT_ID,
  email: 'm@x.t',
  roles: [{ branchId: BRANCH_ID, role: 'manager' }],
  tokenType: 'access',
};
const housekeeper: JwtPayload = {
  sub: 'hk-id',
  tenantId: TENANT_ID,
  email: 'h@x.t',
  roles: [{ branchId: BRANCH_ID, role: 'housekeeper' }],
  tokenType: 'access',
};

function makeTx() {
  return {
    room: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(3),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: ROOM_ID, branchId: BRANCH_ID, ...data }),
      ),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    roomType: {
      findFirst: jest.fn().mockResolvedValue({ id: TYPE_ID }),
      create: jest.fn(),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: TYPE_ID, ...data })),
    },
    floor: { findFirst: jest.fn().mockResolvedValue({ id: FLOOR_ID }) },
    reservation: { findMany: jest.fn().mockResolvedValue([]) },
    roomBlock: {
      create: jest.fn().mockResolvedValue({ id: 'block-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'block-1', ...data })),
      delete: jest.fn().mockResolvedValue({ id: 'block-1' }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

function room(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ROOM_ID,
    branchId: BRANCH_ID,
    occupancyStatus: 'vacant',
    cleanlinessStatus: 'dirty',
    heldStatus: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('RoomsService', () => {
  let service: RoomsService;
  let tx: ReturnType<typeof makeTx>;
  let propertyService: { assertBranch: jest.Mock; findOrCreateDefaultFloor: jest.Mock };
  let objectStorage: { configured: boolean; put: jest.Mock; get: jest.Mock; removeQuietly: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    objectStorage = { configured: false, put: jest.fn(), get: jest.fn(), removeQuietly: jest.fn() };
    propertyService = {
      assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, timezone: 'Africa/Lagos' }),
      findOrCreateDefaultFloor: jest.fn().mockResolvedValue({ id: FLOOR_ID }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        RoomsService,
        {
          provide: PrismaService,
          useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) },
        },
        { provide: PropertyService, useValue: propertyService },
        { provide: ObjectStorageService, useValue: objectStorage },
      ],
    }).compile();
    service = moduleRef.get(RoomsService);
  });

  describe('updateRoomType', () => {
    const ACTOR = 'actor-id';

    it('404s on an unknown room type', async () => {
      tx.roomType.findFirst.mockResolvedValue(null);
      await expect(service.updateRoomType(TENANT_ID, TYPE_ID, { name: 'New Name' }, ACTOR)).rejects.toThrow(NotFoundException);
    });

    it('rounds baseRate to 2dp as a Decimal, same as createRoomType', async () => {
      await service.updateRoomType(TENANT_ID, TYPE_ID, { baseRate: 55000.5 }, ACTOR);
      const data = tx.roomType.update.mock.calls[0][0].data;
      expect(data.baseRate.toFixed(2)).toBe('55000.50');
    });

    it('a field left unset stays undefined, not overwritten', async () => {
      await service.updateRoomType(TENANT_ID, TYPE_ID, { name: 'New Name' }, ACTOR);
      const data = tx.roomType.update.mock.calls[0][0].data;
      expect(data.name).toBe('New Name');
      expect(data.baseRate).toBeUndefined();
      expect(data.capacity).toBeUndefined();
    });

    it('writes an audit log naming the update', async () => {
      await service.updateRoomType(TENANT_ID, TYPE_ID, { name: 'New Name' }, ACTOR);
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'room_type.updated' }) }));
    });
  });

  describe('changeStatus — §4.1 three independent axes', () => {
    it('allows the housekeeping ladder step dirty → cleaning for any staff', async () => {
      tx.room.findFirst.mockResolvedValue(room({ cleanlinessStatus: 'dirty' }));
      const updated = await service.changeStatus(
        TENANT_ID,
        ROOM_ID,
        { cleanlinessStatus: 'cleaning' },
        housekeeper,
      );
      expect(updated.cleanlinessStatus).toBe('cleaning');
      expect(updated.statusChangedBy).toBe(housekeeper.sub);
    });

    it('rejects skipping ladder steps (dirty → clean)', async () => {
      tx.room.findFirst.mockResolvedValue(room({ cleanlinessStatus: 'dirty' }));
      await expect(
        service.changeStatus(TENANT_ID, ROOM_ID, { cleanlinessStatus: 'clean' }, housekeeper),
      ).rejects.toThrow(ConflictException);
    });

    it('only supervisors may set inspected', async () => {
      tx.room.findFirst.mockResolvedValue(room({ cleanlinessStatus: 'clean' }));
      await expect(
        service.changeStatus(TENANT_ID, ROOM_ID, { cleanlinessStatus: 'inspected' }, housekeeper),
      ).rejects.toThrow(ForbiddenException);

      const ok = await service.changeStatus(
        TENANT_ID,
        ROOM_ID,
        { cleanlinessStatus: 'inspected' },
        manager,
      );
      expect(ok.cleanlinessStatus).toBe('inspected');
    });

    it('any state may fall back to dirty', async () => {
      tx.room.findFirst.mockResolvedValue(room({ cleanlinessStatus: 'inspected' }));
      const updated = await service.changeStatus(
        TENANT_ID,
        ROOM_ID,
        { cleanlinessStatus: 'dirty' },
        housekeeper,
      );
      expect(updated.cleanlinessStatus).toBe('dirty');
    });

    it('manual occupancy changes are supervisor-only', async () => {
      tx.room.findFirst.mockResolvedValue(room());
      await expect(
        service.changeStatus(TENANT_ID, ROOM_ID, { occupancyStatus: 'occupied' }, housekeeper),
      ).rejects.toThrow(ForbiddenException);
    });

    it('holding/releasing rooms is supervisor-only, and null releases the hold', async () => {
      tx.room.findFirst.mockResolvedValue(room({ heldStatus: 'out_of_order' }));
      await expect(
        service.changeStatus(TENANT_ID, ROOM_ID, { heldStatus: null }, housekeeper),
      ).rejects.toThrow(ForbiddenException);

      const released = await service.changeStatus(TENANT_ID, ROOM_ID, { heldStatus: null }, manager);
      expect(released.heldStatus).toBeNull();
    });

    it('every change writes an audit row with before/after and the actor', async () => {
      tx.room.findFirst.mockResolvedValue(room({ cleanlinessStatus: 'dirty' }));
      await service.changeStatus(TENANT_ID, ROOM_ID, { cleanlinessStatus: 'cleaning' }, housekeeper);
      expect(tx.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'room.status_changed',
            userId: housekeeper.sub,
            before: expect.objectContaining({ cleanlinessStatus: 'dirty' }),
            after: expect.objectContaining({ cleanlinessStatus: 'cleaning' }),
          }),
        }),
      );
    });

    it('rejects an empty change', async () => {
      await expect(service.changeStatus(TENANT_ID, ROOM_ID, {}, manager)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('bulkCreateRooms', () => {
    it('expands a range: 301–320 with prefix creates 20 rooms', async () => {
      await service.bulkCreateRooms(
        TENANT_ID,
        BRANCH_ID,
        { roomTypeId: TYPE_ID, floorId: FLOOR_ID, range: { from: 301, to: 320 } },
        manager.sub,
      );
      const created = tx.room.createMany.mock.calls[0][0] as { data: Array<{ number: string }> };
      expect(created.data).toHaveLength(20);
      expect(created.data[0].number).toBe('301');
      expect(created.data[19].number).toBe('320');
    });

    it('rejects clashes with existing room numbers (ROOM_NUMBERS_TAKEN)', async () => {
      tx.room.findMany.mockResolvedValueOnce([{ number: '305' }]);
      await expect(
        service.bulkCreateRooms(
          TENANT_ID,
          BRANCH_ID,
          { roomTypeId: TYPE_ID, floorId: FLOOR_ID, range: { from: 301, to: 310 } },
          manager.sub,
        ),
      ).rejects.toThrow(ConflictException);
      expect(tx.room.createMany).not.toHaveBeenCalled();
    });

    it('a number a removed room had brings that room back, vacant and dirty, instead of clashing', async () => {
      tx.room.findMany.mockResolvedValueOnce([{ id: 'old-305', number: '305', deletedAt: new Date('2026-09-01') }]);
      await service.bulkCreateRooms(TENANT_ID, BRANCH_ID, { roomTypeId: TYPE_ID, floorId: FLOOR_ID, numbers: ['305', '306'] }, manager.sub);
      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: 'old-305' },
        data: expect.objectContaining({ deletedAt: null, roomTypeId: TYPE_ID, floorId: FLOOR_ID, occupancyStatus: 'vacant', cleanlinessStatus: 'dirty' }),
      });
      const created = tx.room.createMany.mock.calls[0][0] as { data: Array<{ number: string }> };
      expect(created.data.map((r) => r.number)).toEqual(['306']);
    });

    it('"Rooms Only" onboarding: no floorId → hidden default building/floor is used', async () => {
      await service.bulkCreateRooms(
        TENANT_ID,
        BRANCH_ID,
        { roomTypeId: TYPE_ID, numbers: ['101'] },
        manager.sub,
      );
      expect(propertyService.findOrCreateDefaultFloor).toHaveBeenCalled();
      const created = tx.room.createMany.mock.calls[0][0] as { data: Array<{ floorId: string }> };
      expect(created.data[0].floorId).toBe(FLOOR_ID);
    });

    it('rejects an empty spec (neither range nor numbers)', async () => {
      await expect(
        service.bulkCreateRooms(TENANT_ID, BRANCH_ID, { roomTypeId: TYPE_ID }, manager.sub),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateRoom / removeRoom — after onboarding', () => {
    const SUITE_ID = '66666666-6666-4666-8666-666666666666';
    const today = new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })}T00:00:00.000Z`);
    const day = (n: number) => new Date(today.getTime() + n * 86_400_000);

    beforeEach(() => {
      tx.room.findFirst.mockResolvedValue(room({ number: '101', roomTypeId: TYPE_ID, floorId: FLOOR_ID, view: null, notes: null, roomType: { name: 'Deluxe' } }));
    });

    it('renumbers a room, refusing a number already taken', async () => {
      tx.room.findFirst.mockResolvedValueOnce(room({ number: '101', roomTypeId: TYPE_ID, roomType: { name: 'Deluxe' } })).mockResolvedValueOnce({ deletedAt: null });
      await expect(service.updateRoom(TENANT_ID, ROOM_ID, { number: '102' }, manager.sub)).rejects.toThrow(/already a room 102/);
      tx.room.findFirst.mockResolvedValueOnce(room({ number: '101', roomTypeId: TYPE_ID, roomType: { name: 'Deluxe' } })).mockResolvedValueOnce(null);
      await service.updateRoom(TENANT_ID, ROOM_ID, { number: '101A' }, manager.sub);
      expect(tx.room.update).toHaveBeenCalledWith({ where: { id: ROOM_ID }, data: { number: '101A' } });
    });

    it("won't change the type of a room a guest is in", async () => {
      tx.room.findFirst.mockResolvedValue(room({ occupancyStatus: 'occupied', roomTypeId: TYPE_ID, roomType: { name: 'Deluxe' } }));
      tx.roomType.findFirst.mockResolvedValue({ id: SUITE_ID, name: 'Suite' });
      await expect(service.updateRoom(TENANT_ID, ROOM_ID, { roomTypeId: SUITE_ID }, manager.sub)).rejects.toThrow(/A guest is in this room/);
    });

    it('refuses to leave a type short of rooms for a night it has bookings for', async () => {
      tx.room.findFirst.mockResolvedValue(room({ roomTypeId: TYPE_ID, roomType: { name: 'Deluxe' } }));
      tx.roomType.findFirst.mockResolvedValue({ id: SUITE_ID, name: 'Suite' });
      tx.room.count.mockResolvedValue(2);
      tx.reservation.findMany.mockResolvedValue([
        { checkInDate: day(3), checkOutDate: day(5) },
        { checkInDate: day(4), checkOutDate: day(6) },
      ]);
      await expect(service.updateRoom(TENANT_ID, ROOM_ID, { roomTypeId: SUITE_ID }, manager.sub)).rejects.toThrow(/2 Deluxe bookings need a room on/);
      expect(tx.room.update).not.toHaveBeenCalled();
    });

    it('changes the type when the old one can spare the room, and audits what changed', async () => {
      tx.room.findFirst.mockResolvedValue(room({ roomTypeId: TYPE_ID, roomType: { name: 'Deluxe' } }));
      tx.roomType.findFirst.mockResolvedValue({ id: SUITE_ID, name: 'Suite' });
      tx.room.count.mockResolvedValue(3);
      tx.reservation.findMany.mockResolvedValue([{ checkInDate: day(3), checkOutDate: day(5) }]);
      await service.updateRoom(TENANT_ID, ROOM_ID, { roomTypeId: SUITE_ID }, manager.sub);
      expect(tx.room.update).toHaveBeenCalledWith({ where: { id: ROOM_ID }, data: { roomTypeId: SUITE_ID } });
      expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'room.updated', after: { roomType: { from: 'Deluxe', to: 'Suite' } } }) });
    });

    it('removes a free room, keeping its record', async () => {
      tx.room.findFirst.mockResolvedValue(room({ roomTypeId: TYPE_ID, roomType: { name: 'Deluxe' } }));
      await service.removeRoom(TENANT_ID, ROOM_ID, manager.sub);
      expect(tx.room.update).toHaveBeenCalledWith({ where: { id: ROOM_ID }, data: { deletedAt: expect.any(Date) } });
    });

    it("won't remove a room a guest is in", async () => {
      tx.room.findFirst.mockResolvedValue(room({ occupancyStatus: 'occupied', roomType: { name: 'Deluxe' } }));
      await expect(service.removeRoom(TENANT_ID, ROOM_ID, manager.sub)).rejects.toThrow(ConflictException);
    });
  });

  describe('listRoomsForBranch', () => {
    it('returns [] for a branch with no rooms', async () => {
      const result = await service.listRoomsForBranch(TENANT_ID, BRANCH_ID);
      expect(result).toEqual([]);
      expect(propertyService.assertBranch).toHaveBeenCalled();
    });

    it('rejects an unknown/foreign branch', async () => {
      propertyService.assertBranch.mockRejectedValue(new NotFoundException());
      await expect(service.listRoomsForBranch(TENANT_ID, BRANCH_ID)).rejects.toThrow(NotFoundException);
      expect(tx.room.findMany).not.toHaveBeenCalled();
    });

    it('includes floor/building/room-type detail, scoped and ordered correctly', async () => {
      await service.listRoomsForBranch(TENANT_ID, BRANCH_ID);
      expect(tx.room.findMany).toHaveBeenCalledWith({
        where: { branchId: BRANCH_ID, deletedAt: null },
        include: {
          roomType: { select: { id: true, name: true, bedType: true } },
          floor: {
            select: {
              id: true,
              floorNumber: true,
              label: true,
              building: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: [
          { floor: { building: { name: 'asc' } } },
          { floor: { floorNumber: 'asc' } },
          { number: 'asc' },
        ],
      });
    });
  });

  describe('blockRoom', () => {
    it('rejects an inverted date range', async () => {
      await expect(
        service.blockRoom(
          TENANT_ID,
          ROOM_ID,
          { reason: 'maintenance', fromDate: '2026-08-05', toDate: '2026-08-01' },
          manager.sub,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates the block with attribution + audit', async () => {
      tx.room.findFirst.mockResolvedValue(room());
      await service.blockRoom(
        TENANT_ID,
        ROOM_ID,
        { reason: 'vip_hold', fromDate: '2026-08-01', toDate: '2026-08-05' },
        manager.sub,
      );
      expect(tx.roomBlock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reason: 'vip_hold', createdBy: manager.sub }),
        }),
      );
      expect(tx.auditLog.create).toHaveBeenCalled();
    });

    it('refuses a block overlapping one the room already has', async () => {
      tx.room.findFirst.mockResolvedValue(room({ number: '101' }));
      tx.roomBlock.findFirst.mockResolvedValue({ id: 'block-0', fromDate: new Date('2026-08-03T00:00:00.000Z'), toDate: new Date('2026-08-09T00:00:00.000Z') });
      await expect(service.blockRoom(TENANT_ID, ROOM_ID, { reason: 'maintenance', fromDate: '2026-08-01', toDate: '2026-08-05' }, manager.sub)).rejects.toThrow(
        /already blocked from 2026-08-03 to 2026-08-09/,
      );
      expect(tx.roomBlock.create).not.toHaveBeenCalled();
    });

    it('refuses a block over a guest staying in the room, or a booking given the room', async () => {
      tx.room.findFirst.mockResolvedValue(room({ number: '101' }));
      tx.roomBlock.findFirst.mockResolvedValue(null);
      const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
      tx.reservation.findMany.mockResolvedValueOnce([
        { confirmationNumber: 'RES-1', status: 'checked_in', checkInDate: new Date(`${day(-2)}T00:00:00.000Z`), checkOutDate: new Date(`${day(3)}T00:00:00.000Z`), guest: { name: 'Ada' } },
      ]);
      await expect(service.blockRoom(TENANT_ID, ROOM_ID, { reason: 'maintenance', fromDate: day(1), toDate: day(2) }, manager.sub)).rejects.toThrow(/Ada \(RES-1\) is staying in room 101/);

      tx.reservation.findMany.mockResolvedValueOnce([
        { confirmationNumber: 'RES-2', status: 'confirmed', checkInDate: new Date(`${day(5)}T00:00:00.000Z`), checkOutDate: new Date(`${day(7)}T00:00:00.000Z`), guest: { name: 'Bo' } },
      ]);
      await expect(service.blockRoom(TENANT_ID, ROOM_ID, { reason: 'maintenance', fromDate: day(6), toDate: day(9) }, manager.sub)).rejects.toThrow(/given to Bo's booking RES-2/);
      expect(tx.roomBlock.create).not.toHaveBeenCalled();
    });

    it('lets a block start the day a guest leaves — and not the day an overstaying guest is still there', async () => {
      tx.room.findFirst.mockResolvedValue(room({ number: '101' }));
      tx.roomBlock.findFirst.mockResolvedValue(null);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
      const at = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00.000Z`).getTime() + n * 86_400_000);
      tx.reservation.findMany.mockResolvedValueOnce([
        { confirmationNumber: 'RES-1', status: 'checked_in', checkInDate: at(today, -3), checkOutDate: at(today, 0), guest: { name: 'Ada' } },
      ]);
      await service.blockRoom(TENANT_ID, ROOM_ID, { reason: 'maintenance', fromDate: today, toDate: today }, manager.sub);
      expect(tx.roomBlock.create).toHaveBeenCalledTimes(1);

      tx.reservation.findMany.mockResolvedValueOnce([
        { confirmationNumber: 'RES-1', status: 'checked_in', checkInDate: at(today, -3), checkOutDate: at(today, -1), guest: { name: 'Ada' } },
      ]);
      await expect(service.blockRoom(TENANT_ID, ROOM_ID, { reason: 'maintenance', fromDate: today, toDate: today }, manager.sub)).rejects.toThrow(/is staying in room 101/);
    });
  });

  describe('listActiveBlocks / unblockRoom', () => {
    it('lists only blocks whose toDate is today or later', async () => {
      await service.listActiveBlocks(TENANT_ID, BRANCH_ID);
      expect(tx.roomBlock.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ toDate: { gte: expect.any(Date) } }) }),
      );
    });

    it('ends a block that has started by pulling toDate back to last night — the room sells tonight', async () => {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
      const at = (n: number) => new Date(new Date(`${today}T00:00:00.000Z`).getTime() + n * 86_400_000);
      tx.roomBlock.findFirst.mockResolvedValue({ id: 'block-1', roomId: ROOM_ID, fromDate: at(-3), toDate: at(30), room: room() });
      await service.unblockRoom(TENANT_ID, 'block-1', manager.sub);
      expect(tx.roomBlock.update).toHaveBeenCalledWith({ where: { id: 'block-1' }, data: { toDate: at(-1) } });
      expect(tx.roomBlock.delete).not.toHaveBeenCalled(); // the same row, corrected forward
      expect(tx.roomBlock.create).not.toHaveBeenCalled();
    });

    it('cancels a block that has not started yet, keeping what it was in the audit trail', async () => {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
      const at = (n: number) => new Date(new Date(`${today}T00:00:00.000Z`).getTime() + n * 86_400_000);
      tx.roomBlock.findFirst.mockResolvedValue({ id: 'block-1', roomId: ROOM_ID, reason: 'renovation', fromDate: at(5), toDate: at(7), notes: null, room: room() });
      await service.unblockRoom(TENANT_ID, 'block-1', manager.sub);
      expect(tx.roomBlock.delete).toHaveBeenCalledWith({ where: { id: 'block-1' } });
      expect(tx.roomBlock.update).not.toHaveBeenCalled(); // pulling toDate before fromDate was the server error
      expect(tx.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'room.block_cancelled', after: expect.objectContaining({ reason: 'renovation', fromDate: at(5).toISOString().slice(0, 10) }) }) }),
      );
    });

    it('rejects ending a block that has already ended', async () => {
      // 2 days back, not 1 — keeps this test clear of the UTC/branch-timezone boundary near midnight.
      const pastDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
      tx.roomBlock.findFirst.mockResolvedValue({ id: 'block-1', roomId: ROOM_ID, toDate: new Date(`${pastDate}T00:00:00.000Z`), room: room() });
      await expect(service.unblockRoom(TENANT_ID, 'block-1', manager.sub)).rejects.toThrow(ConflictException);
    });

    it('404s on a missing block', async () => {
      tx.roomBlock.findFirst.mockResolvedValue(null);
      await expect(service.unblockRoom(TENANT_ID, 'nope', manager.sub)).rejects.toThrow(NotFoundException);
    });
  });

  describe('applyReservationOccupancy', () => {
    it('a front-desk actor succeeds — unlike changeStatus, which would reject them for the same occupancy change', async () => {
      tx.room.findFirst.mockResolvedValue(room({ occupancyStatus: 'vacant' }));
      const updated = await service.applyReservationOccupancy(
        tx as never,
        TENANT_ID,
        ROOM_ID,
        { occupancyStatus: 'occupied' },
        housekeeper.sub, // stand-in for a front_desk actor id — this method takes a plain id, not a JwtPayload/role check at all
      );
      expect(updated.occupancyStatus).toBe('occupied');
      expect(tx.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'room.status_changed' }) }),
      );
    });

    it('sets both occupancy and cleanliness in one write when both are passed', async () => {
      tx.room.findFirst.mockResolvedValue(room({ occupancyStatus: 'occupied', cleanlinessStatus: 'clean' }));
      const updated = await service.applyReservationOccupancy(
        tx as never,
        TENANT_ID,
        ROOM_ID,
        { occupancyStatus: 'vacant', cleanlinessStatus: 'dirty' },
        housekeeper.sub,
      );
      expect(updated.occupancyStatus).toBe('vacant');
      expect(updated.cleanlinessStatus).toBe('dirty');
    });

    it('404s on a missing room', async () => {
      tx.room.findFirst.mockResolvedValue(null);
      await expect(
        service.applyReservationOccupancy(tx as never, TENANT_ID, ROOM_ID, { occupancyStatus: 'occupied' }, housekeeper.sub),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('room photo uploads', () => {
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

    it('refuses while no storage is set up — photos stay pasted links', async () => {
      await expect(service.uploadRoomTypePhoto(TENANT_ID, TYPE_ID, { buffer: JPEG, size: JPEG.length }, manager.sub)).rejects.toThrow(/aren’t set up/);
      expect(service.photoUploadsEnabled()).toEqual({ enabled: false, maxBytes: 5 * 1024 * 1024 });
    });

    it('takes only a real JPEG, PNG or WebP, whatever the file claims to be', async () => {
      objectStorage.configured = true;
      const html = Buffer.from('<html><script>alert(1)</script></html>');
      await expect(service.uploadRoomTypePhoto(TENANT_ID, TYPE_ID, { buffer: html, size: html.length }, manager.sub)).rejects.toThrow(/JPEG, PNG or WebP/);
      await expect(service.uploadRoomTypePhoto(TENANT_ID, TYPE_ID, { buffer: JPEG, size: 6 * 1024 * 1024 }, manager.sub)).rejects.toThrow(/at most 5 MB/);
      expect(objectStorage.put).not.toHaveBeenCalled();
    });

    it('serves only a photo name it gave out', async () => {
      objectStorage.configured = true;
      expect(await service.readRoomPhoto(TENANT_ID, TYPE_ID, '../../documents/id.bin')).toBeNull();
      expect(objectStorage.get).not.toHaveBeenCalled();
    });
  });
});
