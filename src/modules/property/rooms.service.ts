import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CleanlinessStatus, OccupancyStatus, Prisma, Room, RoomBlock, RoomType } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CreateRoomTypeDto, UpdateRoomTypeDto } from './dto/room-type.dto';
import { BulkCreateRoomsDto, ChangeRoomStatusDto, CreateRoomBlockDto } from './dto/rooms.dto';
import { PropertyService } from './property.service';

/** Roles that count as "supervisor" for §4.1 (may set `inspected`) and may
 *  touch occupancy/held axes manually. */
const SUPERVISOR_ROLES = new Set(['owner', 'manager']);

/**
 * §4.1 housekeeping ladder: dirty → cleaning → clean → inspected. Any state
 * may drop back to dirty (checkout, spill, re-clean request).
 *
 * Exported (not module-private) so `HousekeepingService`'s task actions —
 * "Start Cleaning" drives dirty→cleaning, "Complete" drives cleaning→clean —
 * validate against this exact ladder rather than a second hand-copied one
 * that could drift out of sync. Same reuse discipline `CARD_TONE_CLASSES` on
 * the frontend already follows for the same reason.
 */
export const CLEANLINESS_TRANSITIONS: Record<CleanlinessStatus, CleanlinessStatus[]> = {
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

  /**
   * Property Config's own room-type editor. Changing `baseRate`/`capacity`
   * here only affects future rate resolutions and new bookings — every
   * existing reservation already has its own `confirmedRate` locked in at
   * booking time (or re-resolved explicitly via `modifyReservation`/
   * `extendStay`), so this never retroactively reprices anything in flight.
   */
  async updateRoomType(tenantId: string, roomTypeId: string, dto: UpdateRoomTypeDto, actorId: string): Promise<RoomType> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.roomType.findFirst({ where: { id: roomTypeId, deletedAt: null } });
      if (!existing) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found' });
      }
      const updated = await tx.roomType.update({
        where: { id: roomTypeId },
        data: {
          name: dto.name,
          baseRate: dto.baseRate !== undefined ? new Prisma.Decimal(dto.baseRate.toFixed(2)) : undefined,
          capacity: dto.capacity as unknown as Prisma.InputJsonValue | undefined,
          bedType: dto.bedType,
          sizeM2: dto.sizeM2 !== undefined ? new Prisma.Decimal(dto.sizeM2.toFixed(1)) : undefined,
          amenities: dto.amenities,
          photoUrls: dto.photoUrls,
          sortOrder: dto.sortOrder,
        },
      });
      await this.audit(tx, tenantId, actorId, 'room_type.updated', 'room_type', roomTypeId, dto as unknown as Prisma.InputJsonValue);
      return updated;
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

  /**
   * Powers the Room Status Board grid — one row per room, already carrying
   * its floor/building/room-type names so the grid doesn't need separate
   * buildings/floors list calls (neither exists yet; nothing else needs
   * them as a first-class resource today, so a purpose-built shape here
   * beats a premature general one — same reasoning `getOnboardingStatus`
   * and `listMyBranches` already used). A floor with zero rooms won't
   * appear (building/floor data only ever arrives nested inside a room
   * row) — accepted for now, a real fix needs actual buildings/floors GET
   * endpoints, which have no other consumer yet either.
   */
  async listRoomsForBranch(tenantId: string, branchId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      return tx.room.findMany({
        where: { branchId, deletedAt: null },
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

  /**
   * System-driven occupancy write for check-in/check-out (`ReservationsService`,
   * a different module — invoked directly, never over HTTP). Deliberately NOT
   * `changeStatus`: that method gates occupancy behind `isSupervisorAt` (owner/
   * manager only) because a MANUAL correction is what it's for; check-in/check-
   * out is a routine front_desk action and must not be blocked by that gate.
   * Reuses `changeStatus`'s exact before/after audit shape, but skips both the
   * supervisor check and the cleanliness ladder validation — this is a system
   * transition, not a human manually picking a state.
   */
  async applyReservationOccupancy(
    tx: TenantTx,
    tenantId: string,
    roomId: string,
    patch: { occupancyStatus: OccupancyStatus; cleanlinessStatus?: CleanlinessStatus },
    actorId: string,
  ): Promise<Room> {
    const room = await tx.room.findFirst({ where: { id: roomId, deletedAt: null } });
    if (!room) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room not found' });
    }
    const before = {
      occupancyStatus: room.occupancyStatus,
      cleanlinessStatus: room.cleanlinessStatus,
      heldStatus: room.heldStatus,
    };
    const updated = await tx.room.update({
      where: { id: roomId },
      data: {
        occupancyStatus: patch.occupancyStatus,
        ...(patch.cleanlinessStatus ? { cleanlinessStatus: patch.cleanlinessStatus } : {}),
        statusChangedAt: new Date(),
        statusChangedBy: actorId,
      },
    });
    await tx.auditLog.create({
      data: {
        tenantId,
        branchId: room.branchId,
        userId: actorId,
        action: 'room.status_changed',
        entityType: 'room',
        entityId: roomId,
        before,
        after: {
          occupancyStatus: updated.occupancyStatus,
          cleanlinessStatus: updated.cleanlinessStatus,
          heldStatus: updated.heldStatus,
          reason: 'reservation_lifecycle',
        },
      },
    });
    return updated;
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

  /** Room Blocking / OOO (ref p31) — every block still in effect today or later, for display and the "N blocked rooms" stat. Past blocks are real history, not shown here, but never deleted. */
  async listActiveBlocks(tenantId: string, branchId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const today = toBranchDate(todayInTimezone(branch.timezone));
      return tx.roomBlock.findMany({
        where: { room: { branchId, deletedAt: null }, toDate: { gte: today } },
        include: { room: { select: { id: true, number: true } } },
        orderBy: { fromDate: 'asc' },
      });
    });
  }

  /**
   * Ends a block early by pulling `toDate` back to today, rather than
   * deleting the row — the block's own history (who created it, why, when)
   * stays queryable, same "correct forward, don't erase" preference the
   * append-only ledger uses for money, applied here to inventory. A block
   * already in the past is left alone; there's nothing to end.
   */
  async unblockRoom(tenantId: string, blockId: string, actorId: string): Promise<RoomBlock> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const block = await tx.roomBlock.findFirst({ where: { id: blockId }, include: { room: true } });
      if (!block) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room block not found' });
      }
      const branch = await this.propertyService.assertBranch(tx, block.room.branchId);
      const today = toBranchDate(todayInTimezone(branch.timezone));
      if (block.toDate < today) {
        throw new ConflictException({ code: ErrorCode.INVALID_STATUS_TRANSITION, message: 'This block has already ended' });
      }
      const updated = await tx.roomBlock.update({ where: { id: blockId }, data: { toDate: today } });
      await this.audit(tx, tenantId, actorId, 'room.unblocked', 'room_block', blockId, { roomId: block.roomId });
      return updated;
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
