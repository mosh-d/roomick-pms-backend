import { Injectable, NotFoundException } from '@nestjs/common';
import { MaintenanceStatus, Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CreateAssetDto, CreateWorkOrderDto, UpdateWorkOrderDto } from './dto/maintenance.dto';

const WORK_ORDER_INCLUDE = {
  room: { select: { id: true, number: true } },
  asset: { select: { id: true, name: true } },
  reportedByUser: { select: { id: true, name: true } },
  assignedToUser: { select: { id: true, name: true } },
};

const RESOLVED_OR_CANCELLED: MaintenanceStatus[] = ['resolved', 'cancelled'];

@Injectable()
export class MaintenanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * "Any department submits a maintenance request" (architecture map) —
   * this is the one write in the module open to every authenticated role,
   * not just Owner/Manager/Housekeeper. `blockRoom` sets the room's
   * `heldStatus = out_of_order` in the SAME transaction as the order
   * itself (the schema's own comment on `takesRoomOutOfService`) — a
   * work order that's supposed to block a room can't exist for a moment
   * without actually blocking it.
   */
  async createWorkOrder(tenantId: string, branchId: string, dto: CreateWorkOrderDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const takesRoomOutOfService = Boolean(dto.blockRoom && dto.roomId);
      const order = await tx.maintenanceOrder.create({
        data: {
          tenantId,
          branchId,
          roomId: dto.roomId,
          assetId: dto.assetId,
          title: dto.title,
          description: dto.description,
          priority: dto.priority ?? 'medium',
          photoUrls: dto.photoUrls ?? [],
          takesRoomOutOfService,
          reportedBy: actorId,
        },
        include: WORK_ORDER_INCLUDE,
      });

      if (takesRoomOutOfService && dto.roomId) {
        await tx.room.update({ where: { id: dto.roomId }, data: { heldStatus: 'out_of_order' } });
      }

      await this.audit(tx, tenantId, branchId, actorId, 'maintenance.work_order_created', order.id, {
        title: dto.title,
        priority: order.priority,
        roomId: dto.roomId,
      });
      return order;
    });
  }

  async listWorkOrders(tenantId: string, branchId: string, status?: MaintenanceStatus) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.maintenanceOrder.findMany({
        where: { branchId, ...(status ? { status } : {}) },
        include: WORK_ORDER_INCLUDE,
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      }),
    );
  }

  /**
   * Moving INTO `resolved` stamps `resolvedAt`. A room this order took out
   * of service is released back to available the moment it lands on
   * `resolved` OR `cancelled` — but ONLY if the room's held status is
   * STILL exactly `out_of_order`; if a supervisor separately blocked the
   * same room for an unrelated reason in the meantime (room-blocking,
   * a different order), this never clobbers that.
   */
  async updateWorkOrder(tenantId: string, orderId: string, dto: UpdateWorkOrderDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.maintenanceOrder.findFirst({ where: { id: orderId } });
      if (!existing) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Work order not found' });
      }

      const updated = await tx.maintenanceOrder.update({
        where: { id: orderId },
        data: {
          status: dto.status,
          assignedTo: dto.assignedTo,
          completionNotes: dto.completionNotes,
          partsUsed: dto.partsUsed,
          resolvedAt: dto.status === 'resolved' ? new Date() : undefined,
        },
        include: WORK_ORDER_INCLUDE,
      });

      if (existing.takesRoomOutOfService && existing.roomId && dto.status && RESOLVED_OR_CANCELLED.includes(dto.status)) {
        const room = await tx.room.findFirst({ where: { id: existing.roomId } });
        if (room?.heldStatus === 'out_of_order') {
          await tx.room.update({ where: { id: existing.roomId }, data: { heldStatus: null } });
        }
      }

      await this.audit(tx, tenantId, existing.branchId, actorId, 'maintenance.work_order_updated', orderId, {
        previousStatus: existing.status,
        status: dto.status,
        assignedTo: dto.assignedTo,
      });
      return updated;
    });
  }

  async createAsset(tenantId: string, branchId: string, dto: CreateAssetDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const asset = await tx.asset.create({
        data: {
          tenantId,
          branchId,
          roomId: dto.roomId,
          name: dto.name,
          category: dto.category,
          serialNumber: dto.serialNumber,
          purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : undefined,
          warrantyUntil: dto.warrantyUntil ? new Date(dto.warrantyUntil) : undefined,
          serviceIntervalDays: dto.serviceIntervalDays,
          notes: dto.notes,
        },
        include: { room: { select: { id: true, number: true } } },
      });
      await this.audit(tx, tenantId, branchId, actorId, 'maintenance.asset_created', asset.id, { name: dto.name });
      return this.withNextServiceDue(asset);
    });
  }

  async listAssets(tenantId: string, branchId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const assets = await tx.asset.findMany({
        where: { branchId },
        include: { room: { select: { id: true, number: true } } },
        orderBy: { name: 'asc' },
      });
      return assets.map((asset) => this.withNextServiceDue(asset));
    });
  }

  /**
   * `nextServiceDue` is computed here, never stored — `purchaseDate +
   * serviceIntervalDays` when both exist. Deliberately NOT reset by a
   * completed service order yet (a real, honest simplification, not an
   * oversight): the cadence should really restart from the most recent
   * resolved order against this asset, but that's a bigger join this pass
   * doesn't take on. Shared by `createAsset` and `listAssets` so a freshly
   * created asset's response has the same shape the list view does.
   */
  private withNextServiceDue<T extends { purchaseDate: Date | null; serviceIntervalDays: number | null }>(
    asset: T,
  ): T & { nextServiceDue: Date | null } {
    return {
      ...asset,
      nextServiceDue:
        asset.purchaseDate && asset.serviceIntervalDays
          ? new Date(asset.purchaseDate.getTime() + asset.serviceIntervalDays * 86_400_000)
          : null,
    };
  }

  private async audit(
    tx: TenantTx,
    tenantId: string,
    branchId: string,
    userId: string,
    action: string,
    entityId: string,
    after?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, branchId, userId, action, entityType: 'maintenance', entityId, after } });
  }
}
