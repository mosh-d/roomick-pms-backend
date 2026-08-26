import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Room, RoomType } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { RoomsService } from '../property/rooms.service';
import { GuestsService } from '../guests/guests.service';
import { CreateGuestDto } from '../guests/dto/guest.dto';
import {
  AvailabilityQueryDto,
  CancelReservationDto,
  CheckInDto,
  CreateReservationDto,
  WalkInReservationDto,
} from './dto/reservation.dto';

const RESERVATION_INCLUDE = {
  guest: { select: { id: true, name: true, email: true, phone: true } },
  roomType: { select: { id: true, name: true } },
  room: { select: { id: true, number: true } },
} as const;

const MAX_AVAILABILITY_RANGE_DAYS = 92;

/** Reservation statuses that hold inventory against a room type (§4.2). */
const HOLDING_STATUSES = ['confirmed', 'checked_in'] as const;

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    private readonly roomsService: RoomsService,
    private readonly guestsService: GuestsService,
  ) {}

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------
  async getAvailability(tenantId: string, branchId: string, dto: AvailabilityQueryDto) {
    const from = toBranchDate(dto.from);
    const to = toBranchDate(dto.to);
    this.assertValidRange(from, to);
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      return this.computeAvailabilityPerNight(tx, branchId, dto.roomTypeId, from, to);
    });
  }

  /**
   * 3 queries total regardless of range length, then bucketed per night in
   * JS. `Room.heldStatus` (a static flag) and `RoomBlock` (a date-ranged
   * table) are two DIFFERENT mechanisms — both must reduce the pool, not
   * just one (a room with no `heldStatus` but a `RoomBlock` covering the
   * requested week is still unavailable for that week).
   *
   * Known, accepted gap: counting-based availability under READ COMMITTED
   * has a real race between two concurrent creates for the last unit of a
   * room type — mitigated in `createReservation` via a `FOR UPDATE` lock
   * on the room type row, not here (this method is also used for the
   * read-only availability endpoint, which has nothing to lock against).
   */
  private async computeAvailabilityPerNight(
    tx: TenantTx,
    branchId: string,
    roomTypeId: string,
    from: Date,
    to: Date,
  ): Promise<Array<{ date: string; available: number }>> {
    const physicalPool = await tx.room.count({
      where: { branchId, roomTypeId, deletedAt: null, heldStatus: null },
    });

    const blocks = await tx.roomBlock.findMany({
      where: {
        room: { branchId, roomTypeId, deletedAt: null, heldStatus: null },
        fromDate: { lt: to },
        toDate: { gte: from },
      },
      select: { roomId: true, fromDate: true, toDate: true },
    });

    const reservations = await tx.reservation.findMany({
      where: {
        branchId,
        roomTypeId,
        deletedAt: null,
        status: { in: [...HOLDING_STATUSES] },
        checkInDate: { lt: to },
        checkOutDate: { gt: from },
      },
      select: { checkInDate: true, checkOutDate: true },
    });

    return this.enumerateNights(from, to).map((night) => {
      const blockedRoomIds = new Set(
        blocks.filter((b) => b.fromDate <= night && b.toDate >= night).map((b) => b.roomId),
      );
      const reservedCount = reservations.filter((r) => r.checkInDate <= night && r.checkOutDate > night).length;
      const available = Math.max(0, physicalPool - blockedRoomIds.size - reservedCount);
      return { date: night.toISOString().slice(0, 10), available };
    });
  }

  private assertValidRange(from: Date, to: Date): void {
    if (to <= from) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'checkOutDate must be after checkInDate' });
    }
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
    if (days > MAX_AVAILABILITY_RANGE_DAYS) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: `Range too long — max ${MAX_AVAILABILITY_RANGE_DAYS} nights`,
      });
    }
  }

  private enumerateNights(from: Date, to: Date): Date[] {
    const nights: Date[] = [];
    for (let d = new Date(from); d < to; d.setUTCDate(d.getUTCDate() + 1)) {
      nights.push(new Date(d));
    }
    return nights;
  }

  // -------------------------------------------------------------------------
  // Create / walk-in
  // -------------------------------------------------------------------------
  async createReservation(tenantId: string, branchId: string, dto: CreateReservationDto, actorId: string) {
    const checkInDate = toBranchDate(dto.checkInDate);
    const checkOutDate = toBranchDate(dto.checkOutDate);
    this.assertValidRange(checkInDate, checkOutDate);
    const guestInput = this.resolveGuestInput(dto);

    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const roomType = await this.assertRoomType(tx, branchId, dto.roomTypeId);
      const guest = await this.guestsService.findOrCreateGuestInTx(tx, tenantId, guestInput);

      // Serializes concurrent creates for the SAME room type only — closes
      // the common "double-book the last room" race without needing a
      // specific room to lock (none is assigned until check-in).
      await tx.$queryRaw`SELECT id FROM room_types WHERE id = ${dto.roomTypeId}::uuid FOR UPDATE`;
      await this.assertAvailableForStay(tx, branchId, dto.roomTypeId, checkInDate, checkOutDate);

      const confirmedRate = this.calculateFlatRate(roomType, checkInDate, checkOutDate);
      const confirmationNumber = await this.generateConfirmationNumber(tx, branchId);

      const reservation = await this.createReservationRow(tx, {
        tenantId,
        branchId,
        guestId: guest.id,
        roomTypeId: dto.roomTypeId,
        confirmationNumber,
        confirmedRate,
        status: 'confirmed',
        channel: dto.channel ?? 'direct',
        checkInDate,
        checkOutDate,
        adults: dto.adults,
        children: dto.children ?? 0,
        specialRequests: dto.specialRequests,
        createdBy: actorId,
      });

      await this.audit(tx, tenantId, branchId, actorId, 'reservation.created', reservation.id, {
        confirmationNumber,
        roomTypeId: dto.roomTypeId,
      });
      return reservation;
    });
  }

  async walkIn(tenantId: string, branchId: string, dto: WalkInReservationDto, actorId: string) {
    const guestInput = this.resolveGuestInput(dto);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const checkInDate = toBranchDate(todayInTimezone(branch.timezone));
      const checkOutDate = toBranchDate(dto.checkOutDate);
      this.assertValidRange(checkInDate, checkOutDate);

      const roomType = await this.assertRoomType(tx, branchId, dto.roomTypeId);
      const guest = await this.guestsService.findOrCreateGuestInTx(tx, tenantId, guestInput);

      const room = await tx.room.findFirst({ where: { id: dto.roomId, deletedAt: null } });
      if (!room) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room not found' });
      }
      await this.assertRoomCheckInReady(tx, room, branchId, dto.roomTypeId, checkInDate, checkOutDate);

      const confirmedRate = this.calculateFlatRate(roomType, checkInDate, checkOutDate);
      const confirmationNumber = await this.generateConfirmationNumber(tx, branchId);

      const reservation = await this.createReservationRow(tx, {
        tenantId,
        branchId,
        guestId: guest.id,
        roomTypeId: dto.roomTypeId,
        roomId: dto.roomId,
        confirmationNumber,
        confirmedRate,
        status: 'checked_in',
        channel: 'walk_in',
        checkInDate,
        checkOutDate,
        actualCheckIn: new Date(),
        adults: dto.adults,
        children: dto.children ?? 0,
        specialRequests: dto.specialRequests,
        createdBy: actorId,
      });

      await this.roomsService.applyReservationOccupancy(tx, tenantId, dto.roomId, { occupancyStatus: 'occupied' }, actorId);

      // One combined audit row, not two — a single atomic action from the guest's perspective.
      await this.audit(tx, tenantId, branchId, actorId, 'reservation.walk_in', reservation.id, {
        confirmationNumber,
        roomId: dto.roomId,
      });
      return reservation;
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  async checkIn(tenantId: string, reservationId: string, dto: CheckInDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.findReservationOrThrow(tx, reservationId);
      if (reservation.status !== 'confirmed') {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `Cannot check in a reservation with status "${reservation.status}"`,
        });
      }
      // Invariant: `roomId` is only ever set AT check-in in this reduced
      // scope (no pre-assign step exists yet) — so a room's live
      // `occupancyStatus` alone is a complete "is anyone in here" signal.
      // This breaks silently the moment a future pass adds a pre-assign
      // step ahead of check-in; re-check this comment if that lands.
      const roomId = reservation.roomId ?? dto.roomId;
      if (!roomId) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'roomId is required — this reservation has no room assigned yet' });
      }

      const room = await tx.room.findFirst({ where: { id: roomId, deletedAt: null } });
      if (!room) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room not found' });
      }
      await this.assertRoomCheckInReady(tx, room, reservation.branchId, reservation.roomTypeId, reservation.checkInDate, reservation.checkOutDate);

      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'checked_in', roomId, actualCheckIn: new Date() },
        include: RESERVATION_INCLUDE,
      });
      await this.roomsService.applyReservationOccupancy(tx, tenantId, roomId, { occupancyStatus: 'occupied' }, actorId);
      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.checked_in', reservationId, { roomId });
      return updated;
    });
  }

  async checkOut(tenantId: string, reservationId: string, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.findReservationOrThrow(tx, reservationId);
      if (reservation.status !== 'checked_in') {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `Cannot check out a reservation with status "${reservation.status}"`,
        });
      }
      // A `checked_in` reservation always has a room (set at check-in, the
      // only place this design ever sets it) — a real runtime check here
      // rather than a bare assertion, since a null would mean a genuine
      // data-integrity bug worth surfacing, not something to silently trust.
      if (!reservation.roomId) {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: 'Checked-in reservation has no room assigned — data integrity issue',
        });
      }
      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'checked_out', actualCheckOut: new Date() },
        include: RESERVATION_INCLUDE,
      });
      // A checked-out room needs cleaning before its next guest — both
      // axes in one write, matching real hotel operations.
      await this.roomsService.applyReservationOccupancy(
        tx,
        tenantId,
        reservation.roomId,
        { occupancyStatus: 'vacant', cleanlinessStatus: 'dirty' },
        actorId,
      );
      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.checked_out', reservationId);
      return updated;
    });
  }

  async cancel(tenantId: string, reservationId: string, dto: CancelReservationDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.findReservationOrThrow(tx, reservationId);
      if (!['confirmed', 'waitlisted'].includes(reservation.status)) {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `Cannot cancel a reservation with status "${reservation.status}"`,
        });
      }
      // No room-release side effect needed: `roomId` is always null
      // pre-check-in in this design (§2.7 of the plan).
      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'cancelled' },
        include: RESERVATION_INCLUDE,
      });
      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.cancelled', reservationId, { reason: dto.reason ?? null });
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------
  async getById(tenantId: string, reservationId: string) {
    return this.prisma.withTenant(tenantId, (tx) => this.findReservationOrThrow(tx, reservationId));
  }

  async listArrivals(tenantId: string, branchId: string, date?: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const day = toBranchDate(date ?? todayInTimezone(branch.timezone));
      return tx.reservation.findMany({
        where: { branchId, deletedAt: null, status: 'confirmed', checkInDate: day },
        include: RESERVATION_INCLUDE,
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  async listDepartures(tenantId: string, branchId: string, date?: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const day = toBranchDate(date ?? todayInTimezone(branch.timezone));
      return tx.reservation.findMany({
        where: { branchId, deletedAt: null, status: 'checked_in', checkOutDate: day },
        include: RESERVATION_INCLUDE,
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  async listInHouse(tenantId: string, branchId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      return tx.reservation.findMany({
        where: { branchId, deletedAt: null, status: 'checked_in' },
        include: RESERVATION_INCLUDE,
        orderBy: { checkOutDate: 'asc' },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------
  private resolveGuestInput(dto: {
    guestId?: string;
    guest?: CreateGuestDto;
  }): { guestId: string } | { guest: CreateGuestDto } {
    if (dto.guestId && dto.guest) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Provide either guestId or guest, not both' });
    }
    if (dto.guestId) return { guestId: dto.guestId };
    if (dto.guest) return { guest: dto.guest };
    throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Provide either guestId or guest' });
  }

  private async assertRoomType(tx: TenantTx, branchId: string, roomTypeId: string): Promise<RoomType> {
    const roomType = await tx.roomType.findFirst({ where: { id: roomTypeId, branchId, deletedAt: null } });
    if (!roomType) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found at this branch' });
    }
    return roomType;
  }

  private async assertAvailableForStay(
    tx: TenantTx,
    branchId: string,
    roomTypeId: string,
    checkInDate: Date,
    checkOutDate: Date,
  ): Promise<void> {
    const perNight = await this.computeAvailabilityPerNight(tx, branchId, roomTypeId, checkInDate, checkOutDate);
    if (perNight.some((n) => n.available < 1)) {
      throw new ConflictException({ code: ErrorCode.RESERVATION_NOT_AVAILABLE, message: 'No rooms of this type are available for the full requested stay' });
    }
  }

  /**
   * Hard-blocks the physically-unsafe axes only (occupancy, held, room
   * blocks) — `cleanlinessStatus` is deliberately a SOFT filter, not
   * enforced here. This reduced scope has no override/reason escape hatch,
   * and trapping front desk with zero ready rooms would be a worse failure
   * than letting them check in anyway; the frontend room picker defaults
   * to only offering clean/inspected rooms, which covers the normal case.
   */
  private async assertRoomCheckInReady(
    tx: TenantTx,
    room: Room,
    branchId: string,
    roomTypeId: string,
    checkInDate: Date,
    checkOutDate: Date,
  ): Promise<void> {
    if (room.branchId !== branchId || room.roomTypeId !== roomTypeId) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Room does not match this reservation\'s branch/room type' });
    }
    if (room.occupancyStatus !== 'vacant' || room.heldStatus !== null) {
      throw new ConflictException({ code: ErrorCode.RESERVATION_NOT_AVAILABLE, message: 'Room is not available' });
    }
    const overlappingBlock = await tx.roomBlock.findFirst({
      where: { roomId: room.id, fromDate: { lt: checkOutDate }, toDate: { gte: checkInDate } },
    });
    if (overlappingBlock) {
      throw new ConflictException({ code: ErrorCode.RESERVATION_NOT_AVAILABLE, message: 'Room is blocked for part of this stay' });
    }
  }

  private calculateFlatRate(roomType: RoomType, checkInDate: Date, checkOutDate: Date): Prisma.Decimal {
    const nights = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / 86_400_000);
    // Flat baseRate × nights — the full Rate Resolver cascade (seasonal/
    // weekend/corporate tiers, promo codes, negotiated overrides) is
    // explicitly out of scope this pass; see PHASE_NOTES.md.
    return new Prisma.Decimal(roomType.baseRate).mul(nights);
  }

  /**
   * `confirmationNumber` is globally `@unique` despite its own schema
   * comment reading "sequence per branch" — a real discrepancy. Predicts a
   * per-branch sequential number, verifies with `findUnique`, retries on
   * collision. The actual `create()` call is ALSO wrapped in a retry loop
   * (see `createReservationRow`) as defense against the TOCTOU window
   * between this probe and the real insert.
   */
  private async generateConfirmationNumber(tx: TenantTx, branchId: string): Promise<string> {
    const year = new Date().getFullYear();
    const count = await tx.reservation.count({ where: { branchId } });
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `RES-${year}-${String(count + 1 + attempt).padStart(5, '0')}`;
      const clash = await tx.reservation.findUnique({ where: { confirmationNumber: candidate } });
      if (!clash) return candidate;
    }
    throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'Could not generate a unique confirmation number' });
  }

  private async createReservationRow(tx: TenantTx, data: Prisma.ReservationUncheckedCreateInput) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await tx.reservation.create({ data, include: RESERVATION_INCLUDE });
      } catch (error) {
        const isUniqueViolation = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!isUniqueViolation || attempt === 2) throw error;
        data.confirmationNumber = await this.generateConfirmationNumber(tx, data.branchId);
      }
    }
    throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'Could not create reservation' });
  }

  private async findReservationOrThrow(tx: TenantTx, reservationId: string) {
    const reservation = await tx.reservation.findFirst({
      where: { id: reservationId, deletedAt: null },
      include: RESERVATION_INCLUDE,
    });
    if (!reservation) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Reservation not found' });
    }
    return reservation;
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
    await tx.auditLog.create({
      data: { tenantId, branchId, userId, action, entityType: 'reservation', entityId, after },
    });
  }
}
