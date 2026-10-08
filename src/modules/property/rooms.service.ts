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
import { BulkCreateRoomsDto, ChangeRoomStatusDto, CreateRoomBlockDto, UpdateRoomDto } from './dto/rooms.dto';
import { PropertyService } from './property.service';

/** Roles that count as "supervisor" for §4.1 (may set `inspected`) and may
 *  touch occupancy/held axes manually. */
const SUPERVISOR_ROLES = new Set(['owner', 'manager']);

/** A stored calendar date as the desk reads it: `2026-10-12`. */
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

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
      await this.audit(
        tx,
        tenantId,
        actorId,
        'room_type.created',
        'room_type',
        roomType.id,
        {
          name: dto.name,
          baseRate: dto.baseRate,
        },
        roomType.branchId,
      );
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
      await this.audit(tx, tenantId, actorId, 'room_type.updated', 'room_type', roomTypeId, dto as unknown as Prisma.InputJsonValue, updated.branchId);
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
        select: { id: true, number: true, deletedAt: true },
      });
      const inUse = clashes.filter((c) => !c.deletedAt);
      if (inUse.length > 0) {
        throw new ConflictException({
          code: ErrorCode.ROOM_NUMBERS_TAKEN,
          message: `Room numbers already exist: ${inUse.map((c) => c.number).join(', ')}`,
        });
      }

      // A number a removed room had comes back as that room — the number stays
      // unique at the branch, and the room's history stays with it — vacant and
      // dirty, to be cleaned before anyone sleeps in it.
      const removedRooms = clashes.filter((c) => c.deletedAt);
      const restored = removedRooms.map((c) => c.number);
      for (const removed of removedRooms) {
        await tx.room.update({
          where: { id: removed.id },
          data: {
            deletedAt: null,
            roomTypeId: dto.roomTypeId,
            floorId,
            view: dto.view ?? null,
            occupancyStatus: 'vacant',
            cleanlinessStatus: 'dirty',
            heldStatus: null,
            statusChangedAt: new Date(),
            statusChangedBy: actorId,
          },
        });
      }
      const fresh = numbers.filter((number) => !restored.includes(number));
      if (fresh.length > 0) {
        await tx.room.createMany({
          data: fresh.map((number) => ({
            tenantId,
            branchId,
            roomTypeId: dto.roomTypeId,
            floorId,
            number,
            view: dto.view,
          })),
        });
      }

      await this.audit(
        tx,
        tenantId,
        actorId,
        'room.bulk_created',
        'room',
        dto.roomTypeId,
        {
          count: numbers.length,
          numbers,
          floorId,
          ...(restored.length > 0 ? { broughtBack: restored } : {}),
        },
        branchId,
      );

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

  /**
   * Edits a room after onboarding — its number, type, floor, view or notes.
   * A type change is refused while a guest is in the room (Room Move moves
   * the guest), and when the room's current type would be left without a
   * room for a night it has bookings for.
   */
  async updateRoom(tenantId: string, roomId: string, dto: UpdateRoomDto, actorId: string): Promise<Room> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const room = await tx.room.findFirst({ where: { id: roomId, deletedAt: null }, include: { roomType: { select: { name: true } } } });
      if (!room) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room not found' });

      const data: Prisma.RoomUncheckedUpdateInput = {};
      const changes: Record<string, { from: unknown; to: unknown }> = {};

      const number = dto.number?.trim();
      if (number && number !== room.number) {
        const taken = await tx.room.findFirst({ where: { branchId: room.branchId, number, id: { not: roomId } }, select: { deletedAt: true } });
        if (taken) {
          throw new ConflictException({
            code: ErrorCode.ROOM_NUMBERS_TAKEN,
            message: taken.deletedAt ? `Room ${number} was removed — add it back from Add Rooms instead` : `There's already a room ${number}`,
          });
        }
        data.number = number;
        changes.number = { from: room.number, to: number };
      }

      if (dto.roomTypeId && dto.roomTypeId !== room.roomTypeId) {
        const roomType = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, branchId: room.branchId, deletedAt: null } });
        if (!roomType) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found at this branch' });
        if (room.occupancyStatus === 'occupied') {
          throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'A guest is in this room — move them with Room Move, or wait for check-out, before changing its type' });
        }
        await this.assertTypeCanSpareARoom(tx, room.branchId, room.roomTypeId, room.roomType.name);
        data.roomTypeId = roomType.id;
        changes.roomType = { from: room.roomType.name, to: roomType.name };
      }

      if (dto.floorId && dto.floorId !== room.floorId) {
        const floor = await tx.floor.findFirst({ where: { id: dto.floorId, building: { branchId: room.branchId } } });
        if (!floor) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Floor not found at this branch' });
        data.floorId = floor.id;
        changes.floor = { from: room.floorId, to: floor.id };
      }
      if (dto.view !== undefined && (dto.view.trim() || null) !== room.view) {
        data.view = dto.view.trim() || null;
        changes.view = { from: room.view, to: data.view };
      }
      if (dto.notes !== undefined && (dto.notes.trim() || null) !== room.notes) {
        data.notes = dto.notes.trim() || null;
        changes.notes = { from: room.notes, to: data.notes };
      }

      if (Object.keys(changes).length === 0) return room;
      const updated = await tx.room.update({ where: { id: roomId }, data });
      await this.audit(tx, tenantId, actorId, 'room.updated', 'room', roomId, changes as Prisma.InputJsonValue, room.branchId);
      return updated;
    });
  }

  /**
   * Takes a room out of the inventory — a room knocked through, turned into
   * an office. Its record and history stay; adding its number back brings it
   * back. Refused while a guest is in it, or when its type would be left
   * without a room for a night it has bookings for.
   */
  async removeRoom(tenantId: string, roomId: string, actorId: string): Promise<Room> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const room = await tx.room.findFirst({ where: { id: roomId, deletedAt: null }, include: { roomType: { select: { name: true } } } });
      if (!room) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room not found' });
      if (room.occupancyStatus === 'occupied') {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'A guest is in this room — move them with Room Move, or wait for check-out, before removing it' });
      }
      await this.assertTypeCanSpareARoom(tx, room.branchId, room.roomTypeId, room.roomType.name);
      const removed = await tx.room.update({ where: { id: roomId }, data: { deletedAt: new Date() } });
      await this.audit(tx, tenantId, actorId, 'room.removed', 'room', roomId, { number: room.number, roomType: room.roomType.name }, room.branchId);
      return removed;
    });
  }

  /**
   * Would `roomTypeId` still have a room for every night it has bookings for,
   * with one room fewer? Bookings hold a room type, not a room, so taking a
   * room out of a type can leave a future night short — the guest would
   * arrive to no room. Counts confirmed and in-house stays from today on —
   * a guest still in the house past their departure date holds tonight too.
   */
  private async assertTypeCanSpareARoom(tx: TenantTx, branchId: string, roomTypeId: string, typeName: string): Promise<void> {
    const branch = await this.propertyService.assertBranch(tx, branchId);
    const today = toBranchDate(todayInTimezone(branch.timezone));
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const [rooms, stays] = await Promise.all([
      tx.room.count({ where: { branchId, roomTypeId, deletedAt: null } }),
      tx.reservation.findMany({
        where: {
          branchId,
          roomTypeId,
          deletedAt: null,
          OR: [{ status: { in: ['confirmed', 'checked_in'] }, checkOutDate: { gt: today } }, { status: 'checked_in' }],
        },
        select: { checkInDate: true, checkOutDate: true, status: true },
      }),
    ]);
    const perNight = new Map<string, number>();
    for (const stay of stays) {
      const end = stay.status === 'checked_in' && stay.checkOutDate <= today ? tomorrow : stay.checkOutDate;
      for (let night = stay.checkInDate > today ? stay.checkInDate : today; night < end; night = new Date(night.getTime() + 86_400_000)) {
        const key = night.toISOString().slice(0, 10);
        perNight.set(key, (perNight.get(key) ?? 0) + 1);
      }
    }
    const [worstNight, booked] = [...perNight].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [null, 0];
    if (worstNight && booked > rooms - 1) {
      throw new ConflictException({
        code: ErrorCode.CONFLICT,
        message: `${booked} ${typeName} ${booked === 1 ? 'booking needs' : 'bookings need'} a room on ${worstNight} — with one ${typeName} fewer there wouldn't be enough. Move or change those bookings first.`,
      });
    }
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
      // One block at a time per room: two overlapping blocks showed the room
      // out of order twice, and ending one left the other quietly holding the dates.
      const overlapping = await tx.roomBlock.findFirst({ where: { roomId, fromDate: { lte: toDate }, toDate: { gte: fromDate } } });
      if (overlapping) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: `Room ${room.number} is already blocked from ${isoDay(overlapping.fromDate)} to ${isoDay(overlapping.toDate)} — end or cancel that block first`,
        });
      }
      // Never out of order under a guest. A stay holding the room for any of
      // these nights moves first — a block over it showed the room out of
      // order while someone slept in it.
      const branch = await this.propertyService.assertBranch(tx, room.branchId);
      const today = toBranchDate(todayInTimezone(branch.timezone));
      const stays = await tx.reservation.findMany({
        where: { roomId, deletedAt: null, status: { in: ['checked_in', 'confirmed'] }, checkInDate: { lte: toDate } },
        select: { confirmationNumber: true, status: true, checkInDate: true, checkOutDate: true, guest: { select: { name: true } } },
      });
      for (const stay of stays) {
        // A guest still in the room after their departure date is there tonight too.
        const leaves = stay.status === 'checked_in' && stay.checkOutDate < today ? new Date(today.getTime() + 86_400_000) : stay.checkOutDate;
        if (leaves <= fromDate) continue;
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message:
            stay.status === 'checked_in'
              ? `${stay.guest.name} (${stay.confirmationNumber}) is staying in room ${room.number} until ${isoDay(leaves)} — block it from that day, or move them to another room first`
              : `Room ${room.number} is given to ${stay.guest.name}'s booking ${stay.confirmationNumber} (${isoDay(stay.checkInDate)} to ${isoDay(stay.checkOutDate)}) — move that booking to another room first`,
        });
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
      await this.audit(
        tx,
        tenantId,
        actorId,
        'room.blocked',
        'room_block',
        block.id,
        {
          roomId,
          reason: dto.reason,
          fromDate: dto.fromDate,
          toDate: dto.toDate,
        },
        room.branchId,
      );
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
   * Ends a block now, so the room can be sold tonight. A block that had
   * already started keeps its row — `toDate` comes back to last night, the
   * last one it actually held — the same "correct forward, don't erase"
   * preference the append-only ledger uses for money, applied to inventory.
   * One that hasn't started yet, or starts today, never held a night: it's
   * cancelled outright, and the audit trail keeps what it was. A block
   * already over is left alone.
   *
   * It used to pull `toDate` back to today whatever the block's start. For a
   * block entered for next week that put `toDate` before its own `fromDate`,
   * which the database refuses — "End Block" failed with a server error and
   * nothing else could remove it — and a block that had started kept
   * tonight blocked after it was "ended".
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
      if (block.fromDate >= today) {
        const cancelled = await tx.roomBlock.delete({ where: { id: blockId } });
        await this.audit(
          tx,
          tenantId,
          actorId,
          'room.block_cancelled',
          'room_block',
          blockId,
          {
            roomId: block.roomId,
            reason: block.reason,
            fromDate: isoDay(block.fromDate),
            toDate: isoDay(block.toDate),
            ...(block.notes ? { notes: block.notes } : {}),
          },
          block.room.branchId,
        );
        return cancelled;
      }
      const lastNight = new Date(today.getTime() - 86_400_000);
      const updated = await tx.roomBlock.update({ where: { id: blockId }, data: { toDate: lastNight } });
      await this.audit(tx, tenantId, actorId, 'room.unblocked', 'room_block', blockId, { roomId: block.roomId, toDate: isoDay(lastNight), wasUntil: isoDay(block.toDate) }, block.room.branchId);
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
    /** The branch it happened at — what the audit-log viewer scopes a branch manager by. */
    branchId?: string | null,
  ): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, branchId: branchId ?? null, userId, action, entityType, entityId, after } });
  }
}
