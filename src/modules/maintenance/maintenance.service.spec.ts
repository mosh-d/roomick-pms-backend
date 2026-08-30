import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { MaintenanceService } from './maintenance.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const ROOM_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR_ID = '55555555-5555-4555-8555-555555555555';

function order(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ORDER_ID,
    branchId: BRANCH_ID,
    roomId: ROOM_ID,
    status: 'open',
    priority: 'medium',
    takesRoomOutOfService: false,
    ...overrides,
  };
}

function makeTx() {
  return {
    maintenanceOrder: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(order({ ...data }))),
      findFirst: jest.fn().mockResolvedValue(order()),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(order({ ...data }))),
    },
    asset: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'asset-1', ...data })),
      findMany: jest.fn().mockResolvedValue([]),
    },
    room: {
      findFirst: jest.fn().mockResolvedValue({ id: ROOM_ID, heldStatus: 'out_of_order' }),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('MaintenanceService', () => {
  let service: MaintenanceService;
  let tx: ReturnType<typeof makeTx>;

  beforeEach(async () => {
    tx = makeTx();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MaintenanceService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
      ],
    }).compile();
    service = moduleRef.get(MaintenanceService);
  });

  describe('createWorkOrder', () => {
    it('defaults priority to medium when omitted', async () => {
      await service.createWorkOrder(TENANT_ID, BRANCH_ID, { title: 'Leaky faucet' }, ACTOR_ID);
      expect(tx.maintenanceOrder.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ priority: 'medium' }) }));
    });

    it('blockRoom + roomId together set takesRoomOutOfService and hold the room', async () => {
      await service.createWorkOrder(TENANT_ID, BRANCH_ID, { title: 'AC broken', roomId: ROOM_ID, blockRoom: true }, ACTOR_ID);
      expect(tx.maintenanceOrder.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ takesRoomOutOfService: true }) }));
      expect(tx.room.update).toHaveBeenCalledWith({ where: { id: ROOM_ID }, data: { heldStatus: 'out_of_order' } });
    });

    it('blockRoom without a roomId does not take anything out of service', async () => {
      await service.createWorkOrder(TENANT_ID, BRANCH_ID, { title: 'Lobby AC broken', blockRoom: true }, ACTOR_ID);
      expect(tx.maintenanceOrder.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ takesRoomOutOfService: false }) }));
      expect(tx.room.update).not.toHaveBeenCalled();
    });

    it('a plain request with no blockRoom never touches the room', async () => {
      await service.createWorkOrder(TENANT_ID, BRANCH_ID, { title: 'Squeaky door', roomId: ROOM_ID }, ACTOR_ID);
      expect(tx.room.update).not.toHaveBeenCalled();
    });

    it('writes an audit log', async () => {
      await service.createWorkOrder(TENANT_ID, BRANCH_ID, { title: 'Leaky faucet' }, ACTOR_ID);
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'maintenance.work_order_created' }) }));
    });
  });

  describe('listWorkOrders', () => {
    it('filters by status when given', async () => {
      await service.listWorkOrders(TENANT_ID, BRANCH_ID, 'in_progress');
      expect(tx.maintenanceOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { branchId: BRANCH_ID, status: 'in_progress' } }));
    });

    it('returns every status when omitted', async () => {
      await service.listWorkOrders(TENANT_ID, BRANCH_ID);
      expect(tx.maintenanceOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { branchId: BRANCH_ID } }));
    });
  });

  describe('updateWorkOrder', () => {
    it('404s on a missing order', async () => {
      tx.maintenanceOrder.findFirst.mockResolvedValue(null);
      await expect(service.updateWorkOrder(TENANT_ID, ORDER_ID, { status: 'in_progress' }, ACTOR_ID)).rejects.toThrow(NotFoundException);
    });

    it('sets resolvedAt only when moving to resolved', async () => {
      await service.updateWorkOrder(TENANT_ID, ORDER_ID, { status: 'resolved' }, ACTOR_ID);
      expect(tx.maintenanceOrder.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ resolvedAt: expect.any(Date) }) }));
    });

    it('does not set resolvedAt for a non-resolved transition', async () => {
      await service.updateWorkOrder(TENANT_ID, ORDER_ID, { status: 'in_progress' }, ACTOR_ID);
      const data = tx.maintenanceOrder.update.mock.calls[0][0].data;
      expect(data.resolvedAt).toBeUndefined();
    });

    it('releases the room hold when a room-blocking order resolves and the hold is still exactly out_of_order', async () => {
      tx.maintenanceOrder.findFirst.mockResolvedValue(order({ takesRoomOutOfService: true }));
      await service.updateWorkOrder(TENANT_ID, ORDER_ID, { status: 'resolved' }, ACTOR_ID);
      expect(tx.room.update).toHaveBeenCalledWith({ where: { id: ROOM_ID }, data: { heldStatus: null } });
    });

    it('also releases on cancelled, not just resolved', async () => {
      tx.maintenanceOrder.findFirst.mockResolvedValue(order({ takesRoomOutOfService: true }));
      await service.updateWorkOrder(TENANT_ID, ORDER_ID, { status: 'cancelled' }, ACTOR_ID);
      expect(tx.room.update).toHaveBeenCalledWith({ where: { id: ROOM_ID }, data: { heldStatus: null } });
    });

    it('does NOT release the hold if the room was re-blocked for an unrelated reason in the meantime', async () => {
      tx.maintenanceOrder.findFirst.mockResolvedValue(order({ takesRoomOutOfService: true }));
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, heldStatus: 'blocked' });
      await service.updateWorkOrder(TENANT_ID, ORDER_ID, { status: 'resolved' }, ACTOR_ID);
      expect(tx.room.update).not.toHaveBeenCalled();
    });

    it('never touches the room when the order never took one out of service', async () => {
      tx.maintenanceOrder.findFirst.mockResolvedValue(order({ takesRoomOutOfService: false }));
      await service.updateWorkOrder(TENANT_ID, ORDER_ID, { status: 'resolved' }, ACTOR_ID);
      expect(tx.room.update).not.toHaveBeenCalled();
    });

    it('an in-progress transition never checks the room at all', async () => {
      tx.maintenanceOrder.findFirst.mockResolvedValue(order({ takesRoomOutOfService: true }));
      await service.updateWorkOrder(TENANT_ID, ORDER_ID, { status: 'in_progress' }, ACTOR_ID);
      expect(tx.room.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('createAsset', () => {
    it('creates with the given fields and audits it', async () => {
      const result = await service.createAsset(TENANT_ID, BRANCH_ID, { name: 'Generator', serviceIntervalDays: 90 }, ACTOR_ID);
      expect(result).toEqual(expect.objectContaining({ name: 'Generator', serviceIntervalDays: 90 }));
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'maintenance.asset_created' }) }));
    });

    it('response includes nextServiceDue, same shape listAssets returns — no separate re-fetch needed to see it', async () => {
      tx.asset.create.mockResolvedValue({ id: 'asset-1', purchaseDate: new Date('2026-01-01T00:00:00.000Z'), serviceIntervalDays: 30 });
      const result = await service.createAsset(TENANT_ID, BRANCH_ID, { name: 'Generator', purchaseDate: '2026-01-01', serviceIntervalDays: 30 }, ACTOR_ID);
      expect(result.nextServiceDue).toEqual(new Date('2026-01-31T00:00:00.000Z'));
    });
  });

  describe('listAssets', () => {
    it('computes nextServiceDue from purchaseDate + serviceIntervalDays', async () => {
      tx.asset.findMany.mockResolvedValue([{ id: 'a1', purchaseDate: new Date('2026-01-01T00:00:00.000Z'), serviceIntervalDays: 10 }]);
      const result = await service.listAssets(TENANT_ID, BRANCH_ID);
      expect(result[0].nextServiceDue).toEqual(new Date('2026-01-11T00:00:00.000Z'));
    });

    it('is null when either purchaseDate or serviceIntervalDays is missing', async () => {
      tx.asset.findMany.mockResolvedValue([
        { id: 'a1', purchaseDate: new Date('2026-01-01T00:00:00.000Z'), serviceIntervalDays: null },
        { id: 'a2', purchaseDate: null, serviceIntervalDays: 30 },
      ]);
      const result = await service.listAssets(TENANT_ID, BRANCH_ID);
      expect(result[0].nextServiceDue).toBeNull();
      expect(result[1].nextServiceDue).toBeNull();
    });
  });
});
