import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from './property.service';
import { RoomsService } from './rooms.service';

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
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: ROOM_ID, branchId: BRANCH_ID, ...data }),
      ),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    roomType: { findFirst: jest.fn().mockResolvedValue({ id: TYPE_ID }), create: jest.fn() },
    floor: { findFirst: jest.fn().mockResolvedValue({ id: FLOOR_ID }) },
    roomBlock: { create: jest.fn().mockResolvedValue({ id: 'block-1' }) },
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

  beforeEach(async () => {
    tx = makeTx();
    propertyService = {
      assertBranch: jest.fn().mockResolvedValue(undefined),
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
      ],
    }).compile();
    service = moduleRef.get(RoomsService);
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
  });
});
