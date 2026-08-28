import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { UsersService } from '../users/users.service';
import { HousekeepingService } from './housekeeping.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = '77777777-7777-4777-8777-777777777777';
const TASK_ID = '66666666-6666-4666-8666-666666666666';
const HOUSEKEEPER_ID = '55555555-5555-4555-8555-555555555555';
const MANAGER_ID = '44444444-4444-4444-8444-444444444444';

const manager: JwtPayload = {
  sub: MANAGER_ID,
  tenantId: TENANT_ID,
  email: 'm@x.t',
  roles: [{ branchId: BRANCH_ID, role: 'manager' }],
  tokenType: 'access',
};
const housekeeperActor: JwtPayload = {
  sub: HOUSEKEEPER_ID,
  tenantId: TENANT_ID,
  email: 'h@x.t',
  roles: [{ branchId: BRANCH_ID, role: 'housekeeper' }],
  tokenType: 'access',
};

function task(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TASK_ID,
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    roomId: ROOM_ID,
    assigneeId: null,
    status: 'pending',
    notes: null,
    ...overrides,
  };
}

function makeTx() {
  return {
    room: {
      findFirst: jest.fn().mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, cleanlinessStatus: 'dirty', deletedAt: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    housekeepingTask: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(task({ ...data }))),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(task({ ...data }))),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('HousekeepingService', () => {
  let service: HousekeepingService;
  let tx: ReturnType<typeof makeTx>;
  let propertyService: { assertBranch: jest.Mock };
  let usersService: { listStaff: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    propertyService = { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, timezone: 'Africa/Lagos' }) };
    usersService = { listStaff: jest.fn().mockResolvedValue([]) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        HousekeepingService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: PropertyService, useValue: propertyService },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();
    service = moduleRef.get(HousekeepingService);
  });

  describe('createTask', () => {
    it('404s on a room from a different branch', async () => {
      tx.room.findFirst.mockResolvedValue(null);
      await expect(service.createTask(TENANT_ID, BRANCH_ID, { roomId: ROOM_ID }, MANAGER_ID)).rejects.toThrow(NotFoundException);
    });

    it('creates a pending, manually-triggered task', async () => {
      await service.createTask(TENANT_ID, BRANCH_ID, { roomId: ROOM_ID, notes: 'Guest complaint' }, MANAGER_ID);
      expect(tx.housekeepingTask.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ roomId: ROOM_ID, triggerEvent: 'manual', notes: 'Guest complaint' }) }),
      );
    });
  });

  describe('startTask — self-claim + drives the room ladder', () => {
    it('rejects starting a task that is not pending', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task({ status: 'in_progress' }));
      await expect(service.startTask(TENANT_ID, TASK_ID, HOUSEKEEPER_ID)).rejects.toThrow(ConflictException);
    });

    it('rejects starting a task already claimed by someone else', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task({ assigneeId: 'someone-else' }));
      await expect(service.startTask(TENANT_ID, TASK_ID, HOUSEKEEPER_ID)).rejects.toThrow(ForbiddenException);
    });

    it('self-assigns an unclaimed task and moves the room dirty -> cleaning', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task({ assigneeId: null }));
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, cleanlinessStatus: 'dirty', deletedAt: null });
      await service.startTask(TENANT_ID, TASK_ID, HOUSEKEEPER_ID);
      expect(tx.room.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cleanlinessStatus: 'cleaning' }) }));
      expect(tx.housekeepingTask.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'in_progress', assigneeId: HOUSEKEEPER_ID }) }),
      );
    });

    it('lets the already-assigned housekeeper start their own task', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task({ assigneeId: HOUSEKEEPER_ID }));
      await expect(service.startTask(TENANT_ID, TASK_ID, HOUSEKEEPER_ID)).resolves.toBeDefined();
    });

    it('rejects the room ladder violation (e.g. room already clean, not dirty)', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task());
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, cleanlinessStatus: 'inspected', deletedAt: null });
      await expect(service.startTask(TENANT_ID, TASK_ID, HOUSEKEEPER_ID)).rejects.toThrow(ConflictException);
    });
  });

  describe('completeTask', () => {
    it('rejects completing a task that is not in_progress', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task({ status: 'pending' }));
      await expect(service.completeTask(TENANT_ID, TASK_ID, HOUSEKEEPER_ID)).rejects.toThrow(ConflictException);
    });

    it('rejects completion by someone other than the assignee', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task({ status: 'in_progress', assigneeId: 'someone-else' }));
      await expect(service.completeTask(TENANT_ID, TASK_ID, HOUSEKEEPER_ID)).rejects.toThrow(ForbiddenException);
    });

    it('moves the room cleaning -> clean and records completedAt/completedBy', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task({ status: 'in_progress', assigneeId: HOUSEKEEPER_ID }));
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, cleanlinessStatus: 'cleaning', deletedAt: null });
      await service.completeTask(TENANT_ID, TASK_ID, HOUSEKEEPER_ID);
      expect(tx.room.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cleanlinessStatus: 'clean' }) }));
      expect(tx.housekeepingTask.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'done', completedBy: HOUSEKEEPER_ID, completedAt: expect.any(Date) }) }),
      );
    });
  });

  describe('assignTask — supervisor only', () => {
    it('rejects a non-supervisor assigning a task', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task());
      await expect(service.assignTask(TENANT_ID, TASK_ID, { assigneeId: HOUSEKEEPER_ID }, housekeeperActor)).rejects.toThrow(ForbiddenException);
    });

    it('lets a manager assign a task to a housekeeper', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task());
      await service.assignTask(TENANT_ID, TASK_ID, { assigneeId: HOUSEKEEPER_ID }, manager);
      expect(tx.housekeepingTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: { assigneeId: HOUSEKEEPER_ID } }));
    });
  });

  describe('reportIssue', () => {
    it('marks the task skipped and appends the area/description to notes', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task({ notes: null }));
      await service.reportIssue(TENANT_ID, TASK_ID, { areaOfIssue: 'Bathroom', description: 'Leaking tap' }, HOUSEKEEPER_ID);
      expect(tx.housekeepingTask.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'skipped', notes: '[Bathroom] Leaking tap' }) }),
      );
    });

    it('does NOT create a RoomBlock — pulling inventory is a separate supervisor decision', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task());
      await service.reportIssue(TENANT_ID, TASK_ID, { areaOfIssue: 'Closet', description: 'Broken hanger rod' }, HOUSEKEEPER_ID);
      // No roomBlock model is even wired into this test's tx — a call to
      // it would throw "is not a function", which the resolved promise
      // above already proves didn't happen.
    });

    it('appends to existing notes rather than overwriting them', async () => {
      tx.housekeepingTask.findFirst.mockResolvedValue(task({ notes: 'Earlier note' }));
      await service.reportIssue(TENANT_ID, TASK_ID, { areaOfIssue: 'Room', description: 'AC noisy' }, HOUSEKEEPER_ID);
      expect(tx.housekeepingTask.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ notes: 'Earlier note\n[Room] AC noisy' }) }),
      );
    });
  });

  describe('listHousekeepers', () => {
    it('filters listStaff down to the housekeeper role at this branch', async () => {
      usersService.listStaff.mockResolvedValue([
        { id: 'a', roles: [{ branchId: BRANCH_ID, role: 'housekeeper', roleId: 'r1' }] },
        { id: 'b', roles: [{ branchId: BRANCH_ID, role: 'front_desk', roleId: 'r2' }] },
        { id: 'c', roles: [{ branchId: null, role: 'housekeeper', roleId: 'r3' }] },
        { id: 'd', roles: [{ branchId: 'other-branch', role: 'housekeeper', roleId: 'r4' }] },
      ]);
      const result = await service.listHousekeepers(TENANT_ID, BRANCH_ID);
      expect(result.map((r) => r.id)).toEqual(['a', 'c']);
    });
  });
});
