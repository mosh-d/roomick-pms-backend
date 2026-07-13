import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CleanlinessStatus, Prisma, Room, RoomBlock, RoomType } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CreateRoomTypeDto } from './dto/room-type.dto';
import { BulkCreateRoomsDto, ChangeRoomStatusDto, CreateRoomBlockDto } from './dto/rooms.dto';
import { PropertyService } from './property.service';

/** Roles that count as "supervisor" for §4.1 (may set `inspected`) and may
 *  touch occupancy/held axes manually. */
const SUPERVISOR_ROLES = new Set(['owner', 'manager']);

/** §4.1 housekeeping ladder: dirty → cleaning → clean → inspected.
 *  Any state may drop back to dirty (checkout, spill, re-clean request). */
const CLEANLINESS_TRANSITIONS: Record<CleanlinessStatus, CleanlinessStatus[]> = {
  dirty: ['cleaning'],
  cleaning: ['clean', 'dirty'],
  clean: ['inspected', 'dirty'],
  inspected: ['dirty'],
};

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
  ) {}

  // -------------------------------------------------------------------------
  // Room types
  // -------------------------------------------------------------------------
  async createRoomType(
    tenantId: string,
    branchId: string,
    dto: CreateRoomTypeDto,
    actorId: string,
  ): Promise<RoomType> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const roomType = await tx.roomType.create({
        data: {
          tenantId,
          branchId,
          name: dto.name,
          baseRate: new Prisma.Decimal(dto.baseRate.toFixed(2)),
          capacity: dto.capacity as unknown as Prisma.InputJsonValue,
          bedType: dto.bedType,
          sizeM2: dto.sizeM2 !== undefined ? new Prisma.Decimal(dto.sizeM2.toFixed(1)) : undefined,
          amenities: dto.amenities ?? [],
          photoUrls: dto.photoUrls ?? [],
          sortOrder: dto.sortOrder,
        },
      });
      await this.audit(tx, tenantId, actorId, 'room_type.created', 'room_type', roomType.id, {
        name: dto.name,
        baseRate: dto.baseRate,
      });
      return roomType;
    });
  }

  async listRoomTypes(tenantId: string, branchId: string): Promise<RoomType[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.roomType.findMany({
        where: { branchId, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Rooms — bulk creation with 3-mode onboarding
  // -------------------------------------------------------------------------
  async bulkCreateRooms(
    tenantId: string,
    branchId: string,
    dto: BulkCreateRoomsDto,
    actorId: string,
  ): Promise<Room[]> {
    const numbers = this.expandNumbers(dto);

    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);

      const roomType = await tx.roomType.findFirst({
        where: { id: dto.roomTypeId, branchId, deletedAt: null },
      });
      if (!roomType) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: 'Room type not found at this branch',
        });
      }

      let floorId = dto.floorId;
      if (floorId) {
        const floor = await tx.floor.findFirst({
          where: { id: floorId, building: { branchId } },
        });
        if (!floor) {
          throw new NotFoundException({
            code: ErrorCode.NOT_FOUND,
            message: 'Floor not found at this branch',
          });
        }
      } else {
        // "Rooms Only" onboarding — hidden default building + floor (spec §1.1).
        floorId = (await this.propertyService.findOrCreateDefaultFloor(tx, tenantId, branchId)).id;
      }

      const clashes = await tx.room.findMany({
        where: { branchId, number: { in: numbers } },
        select: { number: true },
      });
      if (clashes.length > 0) {
        throw new ConflictException({
          code: ErrorCode.ROOM_NUMBERS_TAKEN,
          message: `Room numbers already exist: ${clashes.map((c) => c.number).join(', ')}`,
        });
      }

      await tx.room.createMany({
        data: numbers.map((number) => ({
          tenantId,
          branchId,
          roomTypeId: dto.roomTypeId,
          floorId,
          number,
          view: dto.view,
        })),
      });

      await this.audit(tx, tenantId, actorId, 'room.bulk_created', 'room', dto.roomTypeId, {
        count: numbers.length,
        numbers,
        floorId,
      });

      return tx.room.findMany({
        where: { branchId, number: { in: numbers } },
        orderBy: { number: 'asc' },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Room status — three independent axes (§4.1)
  // -------------------------------------------------------------------------
  async changeStatus(
    tenantId: string,
    roomId: string,
    dto: ChangeRoomStatusDto,
    actor: JwtPayload,
  ): Promise<Room> {
    const wantsOccupancy = dto.occupancyStatus !== undefined;
    const wantsCleanliness = dto.cleanlinessStatus !== undefined;
    const wantsHeld = 'heldStatus' in dto && dto.heldStatus !== undefined;
    if (!wantsOccupancy && !wantsCleanliness && !wantsHeld) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Provide at least one status axis to change',
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const room = await tx.room.findFirst({ where: { id: roomId, deletedAt: null } });
      if (!room) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room not found' });
      }

      const isSupervisor = this.isSupervisorAt(actor, room.branchId);

      // Occupancy is normally driven by check-in/check-out transactions —
      // a manual flip is a supervisor-only correction.
      if (wantsOccupancy && !isSupervisor) {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message: 'Only managers may correct occupancy status manually',
        });
      }

      if (dto.cleanlinessStatus !== undefined) {
        const from = room.cleanlinessStatus;
        const to = dto.cleanlinessStatus;
        if (from !== to && !CLEANLINESS_TRANSITIONS[from].includes(to)) {
          throw new ConflictException({
            code: ErrorCode.INVALID_STATUS_TRANSITION,
            message: `Cleanliness cannot go ${from} → ${to} (ladder: dirty → cleaning → clean → inspected)`,
          });
        }
        if (to === 'inspected' && !isSupervisor) {
          throw new ForbiddenException({
            code: ErrorCode.FORBIDDEN,
            message: 'Only supervisors may mark a room inspected',
          });
        }
      }

      if (wantsHeld && !isSupervisor) {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message: 'Only managers may hold or release rooms',
        });
      }

      const before = {
        occupancyStatus: room.occupancyStatus,
        cleanlinessStatus: room.cleanlinessStatus,
        heldStatus: room.heldStatus,
      };

      const updated = await tx.room.update({
        where: { id: roomId },
        data: {
          ...(wantsOccupancy ? { occupancyStatus: dto.occupancyStatus } : {}),
          ...(wantsCleanliness ? { cleanlinessStatus: dto.cleanlinessStatus } : {}),
          ...(wantsHeld ? { heldStatus: dto.heldStatus } : {}),
          statusChangedAt: new Date(),
          statusChangedBy: actor.sub, // NULL would mean system (§4.1)
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          branchId: room.branchId,
          userId: actor.sub,
          action: 'room.status_changed',
          entityType: 'room',
          entityId: roomId,
          before,
          after: {
            occupancyStatus: updated.occupancyStatus,
            cleanlinessStatus: updated.cleanlinessStatus,
            heldStatus: updated.heldStatus,
            reason: dto.reason ?? null,
          },
        },
      });

      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Room blocks
  // -------------------------------------------------------------------------
  async blockRoom(
    tenantId: string,
    roomId: string,
    dto: CreateRoomBlockDto,
    actorId: string,
  ): Promise<RoomBlock> {
    const fromDate = new Date(dto.fromDate);
    const toDate = new Date(dto.toDate);
    if (toDate < fromDate) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'toDate must not be before fromDate',
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const room = await tx.room.findFirst({ where: { id: roomId, deletedAt: null } });
      if (!room) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room not found' });
      }
      const block = await tx.roomBlock.create({
        data: {
          tenantId,
          roomId,
          reason: dto.reason,
          fromDate,
          toDate,
          notes: dto.notes,
          createdBy: actorId,
        },
      });
      await this.audit(tx, tenantId, actorId, 'room.blocked', 'room_block', block.id, {
        roomId,
        reason: dto.reason,
        fromDate: dto.fromDate,
        toDate: dto.toDate,
      });
      return block;
    });
  }

  // -------------------------------------------------------------------------
  private expandNumbers(dto: BulkCreateRoomsDto): string[] {
    const numbers: string[] = [];
    if (dto.range) {
      if (dto.range.to < dto.range.from) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: 'range.to must be ≥ range.from',
        });
      }
      if (dto.range.to - dto.range.from + 1 > 500) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Cannot create more than 500 rooms per request',
        });
      }
      for (let n = dto.range.from; n <= dto.range.to; n++) {
        numbers.push(`${dto.range.prefix ?? ''}${n}`);
      }
    }
    if (dto.numbers) numbers.push(...dto.numbers.map((n) => n.trim()).filter(Boolean));

    const unique = [...new Set(numbers)];
    if (unique.length === 0) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Provide a range and/or a numbers list',
      });
    }
    return unique;
  }

  private isSupervisorAt(actor: JwtPayload, branchId: string): boolean {
    return actor.roles.some(
      (r) =>
        SUPERVISOR_ROLES.has(r.role) && (r.branchId === null || r.branchId === branchId),
    );
  }

  private async audit(
    tx: TenantTx,
    tenantId: string,
    userId: string,
    action: string,
    entityType: string,
    entityId: string,
    after?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, userId, action, entityType, entityId, after } });
  }
}
