import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { NoShowRecord, PenaltyType, Prisma, Room, RoomType } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { RoomsService } from '../property/rooms.service';
import { GuestsService } from '../guests/guests.service';
import { CreateGuestDto } from '../guests/dto/guest.dto';
import { FoliosService } from '../folios/folios.service';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { RateResolverService } from '../rate-resolver/rate-resolver.service';
import { RegistrationCardsService } from '../registration-cards/registration-cards.service';
import { CommsLogService } from '../comms-log/comms-log.service';
import {
  AvailabilityCalendarQueryDto,
  AvailabilityQueryDto,
  CancelReservationDto,
  CheckInDto,
  CreateReservationDto,
  ListReservationsQueryDto,
  ModifyReservationDto,
  ReinstateNoShowDto,
  WalkInReservationDto,
  WalkReservationDto,
} from './dto/reservation.dto';

const RESERVATION_INCLUDE = {
  guest: { select: { id: true, name: true, email: true, phone: true } },
  roomType: { select: { id: true, name: true } },
  room: { select: { id: true, number: true } },
  // The check-in night's winning plan only — see `RateResolverService
  // .resolveStay`'s own comment on why a single FK can't represent a stay
  // whose rate changes mid-week. NULL when the stay resolved to the plain
  // base rate (no cascade/override plan applied).
  ratePlan: { select: { id: true, name: true, type: true } },
  // Reservations carry no currency field of their own — a reservation's
  // money is always the branch's own currency. Included here so any screen
  // showing `confirmedRate` (e.g. Modify Reservation's cost preview) can
  // format it correctly without a second round-trip to fetch the branch.
  branch: { select: { currency: true } },
  // Latest mark only — a reinstated-then-re-no-showed reservation could in
  // theory carry more than one record, but the No-Show Handling screen
  // (its only consumer) only ever needs the current one to show/waive.
  noShowRecords: { orderBy: { markedAt: 'desc' as const }, take: 1 },
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
    private readonly foliosService: FoliosService,
    private readonly housekeepingService: HousekeepingService,
    private readonly rateResolverService: RateResolverService,
    private readonly registrationCardsService: RegistrationCardsService,
    private readonly commsLogService: CommsLogService,
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
   * The Availability Calendar (ref p21): every active room type at the
   * branch, per-night available counts across a full month. Loops
   * `computeAvailabilityPerNight` per room type rather than a single
   * combined query — branches have a handful of room types (single digits
   * in practice), and reusing the already-correct, already-tested
   * per-room-type logic beats a riskier rewrite for what's still 3 queries
   * per room type, not per day.
   */
  async getAvailabilityCalendar(tenantId: string, branchId: string, dto: AvailabilityCalendarQueryDto) {
    const from = new Date(Date.UTC(dto.year, dto.month - 1, 1));
    const to = new Date(Date.UTC(dto.year, dto.month, 1));
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const roomTypes = await tx.roomType.findMany({
        where: { branchId, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      const roomTypesWithAvailability = await Promise.all(
        roomTypes.map(async (roomType) => ({
          roomTypeId: roomType.id,
          roomTypeName: roomType.name,
          nights: await this.computeAvailabilityPerNight(tx, branchId, roomType.id, from, to),
        })),
      );
      return { year: dto.year, month: dto.month, roomTypes: roomTypesWithAvailability };
    });
  }

  /**
   * Overbooking exposure (ref: "heatmap data: confirmed vs capacity vs
   * threshold per date") — every active room type, every night in range,
   * with the full picture `computeAvailabilityPerNight`'s own `{date,
   * available}` deliberately doesn't expose (that method stays a plain
   * gate every other caller — booking creation, modify, the plain
   * availability calendar — consumes without carrying overbooking detail
   * they don't need). Some query duplication against that method is
   * accepted here rather than bending its return shape to also serve this.
   */
  async getOverbookingExposure(tenantId: string, branchId: string, dto: AvailabilityCalendarQueryDto) {
    const from = new Date(Date.UTC(dto.year, dto.month - 1, 1));
    const to = new Date(Date.UTC(dto.year, dto.month, 1));
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const roomTypes = await tx.roomType.findMany({ where: { branchId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } });

      const roomTypesWithExposure = await Promise.all(
        roomTypes.map(async (roomType) => {
          const physicalPool = await tx.room.count({ where: { branchId, roomTypeId: roomType.id, deletedAt: null, heldStatus: null } });
          const blocks = await tx.roomBlock.findMany({
            where: { room: { branchId, roomTypeId: roomType.id, deletedAt: null, heldStatus: null }, fromDate: { lt: to }, toDate: { gte: from } },
            select: { roomId: true, fromDate: true, toDate: true },
          });
          const reservations = await tx.reservation.findMany({
            where: { branchId, roomTypeId: roomType.id, deletedAt: null, status: { in: [...HOLDING_STATUSES] }, checkInDate: { lt: to }, checkOutDate: { gt: from } },
            select: { checkInDate: true, checkOutDate: true },
          });
          const overbookingConfigs = await tx.overbookingConfig.findMany({ where: { branchId, OR: [{ roomTypeId: roomType.id }, { roomTypeId: null }] } });
          const roomTypeConfig = overbookingConfigs.find((c) => c.roomTypeId === roomType.id);
          const branchConfig = overbookingConfigs.find((c) => c.roomTypeId === null);

          const nights = this.enumerateNights(from, to).map((night) => {
            const blockedCount = blocks.filter((b) => b.fromDate <= night && b.toDate >= night).length;
            const reservedCount = reservations.filter((r) => r.checkInDate <= night && r.checkOutDate > night).length;
            const netCapacity = physicalPool - blockedCount;
            const governingConfig = this.overbookingConfigFor(roomTypeConfig, branchConfig, night);
            const ceilingCapacity = governingConfig ? Math.floor(netCapacity * (1 + Number(governingConfig.maxOverbookPct ?? 0) / 100)) : netCapacity;
            const alertThreshold = governingConfig?.alertAtPct ? Math.floor(netCapacity * (Number(governingConfig.alertAtPct) / 100)) : null;
            return {
              date: night.toISOString().slice(0, 10),
              physicalPool,
              netCapacity,
              ceilingCapacity,
              reservedCount,
              isOverbooked: reservedCount > netCapacity,
              isAlerting: alertThreshold !== null && reservedCount >= alertThreshold,
            };
          });
          return { roomTypeId: roomType.id, roomTypeName: roomType.name, nights };
        }),
      );

      return { year: dto.year, month: dto.month, roomTypes: roomTypesWithExposure };
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
   *
   * Overbooking (ref: Month 4) raises the ceiling a night can book against,
   * past physical capacity, when `OverbookingConfig.globalEnabled` and the
   * night falls inside its `validFrom`/`validTo` window — "by default
   * overbooking is off (hard block); a property must enable and set %"
   * (ref). A room-type-specific config row governs over the branch-wide
   * (`roomTypeId: null`) one for a night only if IT it also governs that
   * night; otherwise the branch-wide row is used. This is the ONE place
   * that decision is made — every caller (booking creation, modify,
   * promote, reinstate, the availability calendar) inherits it for free.
   */
  private async computeAvailabilityPerNight(
    tx: TenantTx,
    branchId: string,
    roomTypeId: string,
    from: Date,
    to: Date,
    excludeReservationId?: string,
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
        // Modifying a reservation re-checks availability for its (possibly
        // unchanged) dates — without this exclusion, the reservation would
        // count as occupying a room against itself, wrongly reporting no
        // availability for a change that doesn't actually need a new room.
        ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
      },
      select: { checkInDate: true, checkOutDate: true },
    });

    const overbookingConfigs = await tx.overbookingConfig.findMany({ where: { branchId, OR: [{ roomTypeId }, { roomTypeId: null }] } });
    const roomTypeConfig = overbookingConfigs.find((c) => c.roomTypeId === roomTypeId);
    const branchConfig = overbookingConfigs.find((c) => c.roomTypeId === null);

    return this.enumerateNights(from, to).map((night) => {
      const blockedRoomIds = new Set(
        blocks.filter((b) => b.fromDate <= night && b.toDate >= night).map((b) => b.roomId),
      );
      const reservedCount = reservations.filter((r) => r.checkInDate <= night && r.checkOutDate > night).length;
      const netCapacity = physicalPool - blockedRoomIds.size;
      const governingConfig = this.overbookingConfigFor(roomTypeConfig, branchConfig, night);
      const capacity = governingConfig
        ? Math.floor(netCapacity * (1 + Number(governingConfig.maxOverbookPct ?? 0) / 100))
        : netCapacity;
      const available = Math.max(0, capacity - reservedCount);
      return { date: night.toISOString().slice(0, 10), available };
    });
  }

  private overbookingConfigFor<
    T extends { globalEnabled: boolean; validFrom: Date | null; validTo: Date | null; maxOverbookPct: Prisma.Decimal | null },
  >(roomTypeConfig: T | undefined, branchConfig: T | undefined, night: Date): T | null {
    const governs = (c: T | undefined): c is T =>
      !!c && c.globalEnabled && (!c.validFrom || c.validFrom <= night) && (!c.validTo || c.validTo >= night);
    if (governs(roomTypeConfig)) return roomTypeConfig;
    if (governs(branchConfig)) return branchConfig;
    return null;
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
      // `joinWaitlist` is an explicit request to skip the availability
      // check, not an automatic fallback — a plain booking that finds no
      // rooms still throws `RESERVATION_NOT_AVAILABLE`, same as before.
      if (!dto.joinWaitlist) {
        await this.assertAvailableForStay(tx, branchId, dto.roomTypeId, checkInDate, checkOutDate);
      }

      const resolved = await this.rateResolverService.resolveStay(
        tx,
        tenantId,
        branchId,
        roomType,
        checkInDate,
        checkOutDate,
        { promoCode: dto.promoCode, corporateAccountId: dto.corporateAccountId },
        { triggeredBy: 'booking_create', userId: actorId },
      );
      const confirmationNumber = await this.generateConfirmationNumber(tx, tenantId, branchId);

      const reservation = await this.createReservationRow(tx, {
        tenantId,
        branchId,
        guestId: guest.id,
        roomTypeId: dto.roomTypeId,
        ratePlanId: resolved.ratePlanId,
        confirmationNumber,
        confirmedRate: resolved.subtotal,
        status: dto.joinWaitlist ? 'waitlisted' : 'confirmed',
        channel: dto.channel ?? 'direct',
        checkInDate,
        checkOutDate,
        adults: dto.adults,
        children: dto.children ?? 0,
        specialRequests: dto.specialRequests,
        createdBy: actorId,
      });
      await this.rateResolverService.linkAuditLogsToReservation(tx, resolved.auditLogIds, reservation.id);

      await this.audit(tx, tenantId, branchId, actorId, 'reservation.created', reservation.id, {
        confirmationNumber,
        roomTypeId: dto.roomTypeId,
      });
      if (!dto.joinWaitlist) {
        await this.commsLogService.logAutomatedInTx(tx, tenantId, branchId, {
          reservationId: reservation.id,
          guestId: guest.id,
          channel: 'email',
          subject: `Reservation Confirmed — ${confirmationNumber}`,
          body: `Your reservation ${confirmationNumber} is confirmed — ${roomType.name}, ${dto.checkInDate} to ${dto.checkOutDate}.`,
          trigger: 'booking_confirmation',
        });
      }
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

      const resolved = await this.rateResolverService.resolveStay(
        tx,
        tenantId,
        branchId,
        roomType,
        checkInDate,
        checkOutDate,
        { promoCode: dto.promoCode, corporateAccountId: dto.corporateAccountId },
        { triggeredBy: 'walkin', userId: actorId },
      );
      const confirmationNumber = await this.generateConfirmationNumber(tx, tenantId, branchId);

      const reservation = await this.createReservationRow(tx, {
        tenantId,
        branchId,
        guestId: guest.id,
        roomTypeId: dto.roomTypeId,
        roomId: dto.roomId,
        ratePlanId: resolved.ratePlanId,
        confirmationNumber,
        confirmedRate: resolved.subtotal,
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
      await this.rateResolverService.linkAuditLogsToReservation(tx, resolved.auditLogIds, reservation.id);

      await this.roomsService.applyReservationOccupancy(tx, tenantId, dto.roomId, { occupancyStatus: 'occupied' }, actorId);

      // Same arrival-night-only accrual as `checkIn` — see its comment.
      const folio = await this.foliosService.ensurePrimaryFolio(tx, reservation, actorId);
      await this.foliosService.postRoomChargeForDate(tx, reservation, folio, checkInDate, 'Walk-in', actorId);

      if (dto.idDocument) {
        await this.guestsService.recordIdDocumentInTx(tx, tenantId, branchId, guest.id, dto.idDocument, actorId);
      }

      // A walk-in IS a check-in (create + immediate check-in in one call) — same "auto-generated when check-in is triggered" rule `checkIn` follows.
      await this.registrationCardsService.generateCardInTx(tx, tenantId, { ...reservation, branch: { currency: reservation.branch.currency, regCardTemplate: branch.regCardTemplate } }, actorId);

      // One combined audit row, not two — a single atomic action from the guest's perspective.
      await this.audit(tx, tenantId, branchId, actorId, 'reservation.walk_in', reservation.id, {
        confirmationNumber,
        roomId: dto.roomId,
      });
      // A walk-in has no gap between booking and arrival, so only a
      // check-in receipt makes sense here — no separate "your booking is
      // confirmed" email the way an advance reservation gets.
      await this.commsLogService.logAutomatedInTx(tx, tenantId, branchId, {
        reservationId: reservation.id,
        guestId: guest.id,
        channel: 'email',
        subject: `Welcome — ${confirmationNumber}`,
        body: `Welcome! You're checked in to room ${room.number} (${roomType.name}). Check-out is ${dto.checkOutDate}.`,
        trigger: 'checkin_receipt',
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

      // Open the folio and accrue the ARRIVAL NIGHT only — not the whole
      // stay. Each subsequent night is posted by night audit through the
      // same `postRoomChargeForDate`, which refuses to double-post a date
      // that's already billed. See its own comment for why the rate comes
      // off the reservation rather than the room type.
      const folio = await this.foliosService.ensurePrimaryFolio(tx, updated, actorId);
      await this.foliosService.postRoomChargeForDate(tx, updated, folio, updated.checkInDate, 'Check-in', actorId);

      if (dto.idDocument) {
        await this.guestsService.recordIdDocumentInTx(tx, tenantId, reservation.branchId, updated.guestId, dto.idDocument, actorId);
      }

      // "Auto-generated when check-in is triggered" (ref) — a legal
      // document, not an afterthought, so it's part of THIS transaction,
      // not a fire-and-forget follow-up call.
      const branch = await this.propertyService.assertBranch(tx, reservation.branchId);
      await this.registrationCardsService.generateCardInTx(tx, tenantId, { ...updated, branch: { currency: updated.branch.currency, regCardTemplate: branch.regCardTemplate } }, actorId);

      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.checked_in', reservationId, { roomId });
      await this.commsLogService.logAutomatedInTx(tx, tenantId, reservation.branchId, {
        reservationId,
        guestId: updated.guestId,
        channel: 'email',
        subject: `Welcome — ${updated.confirmationNumber}`,
        body: `Welcome! You're checked in to room ${room.number} (${updated.roomType.name}). Check-out is ${updated.checkOutDate.toISOString().slice(0, 10)}.`,
        trigger: 'checkin_receipt',
      });
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
      const branch = await this.propertyService.assertBranch(tx, reservation.branchId);
      // A checked-out room needs cleaning before its next guest — both
      // axes in one write, matching real hotel operations.
      await this.roomsService.applyReservationOccupancy(
        tx,
        tenantId,
        reservation.roomId,
        { occupancyStatus: 'vacant', cleanlinessStatus: 'dirty' },
        actorId,
      );
      // Task Board reflects a checked-out room automatically — nobody has
      // to remember to flag it. `triggeredByReservationId` is what makes
      // this traceable back to the stay that caused it.
      await this.housekeepingService.createTaskInTx(tx, tenantId, reservation.branchId, {
        roomId: reservation.roomId,
        triggerEvent: 'checkout',
        triggeredByReservationId: reservationId,
        taskDate: toBranchDate(todayInTimezone(branch.timezone)),
        actorId,
      });

      // **Check-out is NEVER blocked by an outstanding balance** — the room
      // has to release either way. A departing guest who still owes becomes
      // a City Ledger receivable (a collections matter), which the folio
      // list derives from `reservation.status` + balance; a still-in-house
      // guest who owes is a Guest Ledger matter front desk resolves before
      // departure. This mirrors the in-house PMS
      // (`five-clover-nestjs-backend/docs/PMS-OPERATIONS-GUIDE.md:218`) and
      // Cloudbeds, whose AR transfer likewise happens *after* check-out.
      // `settleIfFullyPaid` therefore never throws — `FOLIO_NOT_SETTLED`
      // belongs to the explicit `closeFolio` path alone.
      const folio = await this.foliosService.ensurePrimaryFolio(tx, updated, actorId);
      // Safety net: bill any elapsed night the night audit hasn't reached
      // yet (it runs early-morning, so a guest departing today would
      // otherwise leave with last night un-posted). Idempotent per date.
      await this.foliosService.backfillRoomCharges(
        tx,
        updated,
        folio,
        toBranchDate(todayInTimezone(branch.timezone)),
        'Check-out',
        actorId,
      );
      await this.foliosService.settleIfFullyPaid(tx, folio, actorId, 'checkOut');

      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.checked_out', reservationId);
      await this.commsLogService.logAutomatedInTx(tx, tenantId, reservation.branchId, {
        reservationId,
        guestId: updated.guestId,
        channel: 'email',
        subject: `Thank You For Staying — ${updated.confirmationNumber}`,
        body: `Thank you for staying with us. Your stay (${updated.confirmationNumber}) has ended — we hope to see you again.`,
        trigger: 'post_stay',
      });
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
      await this.commsLogService.logAutomatedInTx(tx, tenantId, reservation.branchId, {
        reservationId,
        guestId: updated.guestId,
        channel: 'email',
        subject: `Reservation Cancelled — ${updated.confirmationNumber}`,
        body: `Your reservation ${updated.confirmationNumber} has been cancelled.${dto.reason ? ` Reason: ${dto.reason}` : ''}`,
        trigger: 'cancellation',
      });
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // No-Show Handling (ref: MVP timeline Month 3)
  // -------------------------------------------------------------------------

  /** Front desk's own live view of "who hasn't shown up yet" — the SAME query `NightAuditService.getPreflight`'s `unresolvedNoShows` already runs, exposed here as its own dashboard reachable any time during the day, not just when checking whether night audit is safe to run. */
  async listPendingNoShows(tenantId: string, branchId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const today = toBranchDate(todayInTimezone(branch.timezone));
      return tx.reservation.findMany({
        where: { branchId, deletedAt: null, status: 'confirmed', checkInDate: { lte: today } },
        include: RESERVATION_INCLUDE,
        orderBy: { checkInDate: 'asc' },
      });
    });
  }

  /**
   * The manual entry point (ref: "Mark as no-show: atomic — penalty
   * posted, room released, folio closed") — front desk marking someone no-
   * show proactively during the day, not waiting for the automated
   * midnight sweep `NightAuditService` also runs. Both paths converge on
   * `markNoShowInTx` so a penalty is applied identically either way.
   *
   * "Room released" has no separate step here: a `confirmed` reservation
   * that never checked in never held a physical room (`roomId` stays NULL
   * until check-in), so there's nothing to release — the reservation
   * simply stops appearing in `HOLDING_STATUSES` the instant its status
   * changes, which is what already frees its inventory everywhere else in
   * this file. "Folio closed" only happens when true: a zero/no-penalty
   * no-show settles immediately (nothing owed); a penalized one stays open
   * as a City Ledger receivable, the exact same rule check-out already
   * uses — see its own comment for why "never block, never lie about the
   * balance" beats forcing a close.
   */
  async markNoShow(tenantId: string, reservationId: string, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.findReservationOrThrow(tx, reservationId);
      if (reservation.status !== 'confirmed') {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `Cannot mark a reservation with status "${reservation.status}" as a no-show — only a confirmed reservation can be`,
        });
      }
      const branch = await this.propertyService.assertBranch(tx, reservation.branchId);
      const policy = (branch.noShowPolicy ?? {}) as { defaultPenalty?: PenaltyType; flatFeeAmount?: number };
      const penaltyType = policy.defaultPenalty ?? 'none';
      return this.markNoShowInTx(tx, tenantId, reservation, penaltyType, policy.flatFeeAmount, actorId);
    });
  }

  /**
   * Shared core — also called from `NightAuditService.markNoShows` for the
   * automated sweep, so a night-audit-marked no-show gets the identical
   * penalty-charge treatment a manually-marked one does. `markedBy: null`
   * for that path (the schema's own convention: "NULL = auto-marked").
   *
   * `reservation` takes only the fields this actually touches, not the
   * full `RESERVATION_INCLUDE` shape `findReservationOrThrow` returns —
   * `NightAuditService`'s own batch query (every unarrived reservation for
   * a branch) doesn't need to fetch guest/room/ratePlan/branch just to
   * pass reservations through here, and requiring that shape would force
   * it to.
   */
  async markNoShowInTx(
    tx: TenantTx,
    tenantId: string,
    reservation: {
      id: string;
      branchId: string;
      createdBy: string | null;
      confirmedRate: Prisma.Decimal;
      overrideRate: Prisma.Decimal | null;
      checkInDate: Date;
      checkOutDate: Date;
    },
    penaltyType: PenaltyType,
    flatFeeAmount: number | undefined,
    markedBy: string | null,
  ) {
    const updated = await tx.reservation.update({
      where: { id: reservation.id },
      data: { status: 'no_show' },
      include: RESERVATION_INCLUDE,
    });

    const penaltyAmount = this.penaltyAmountFor(reservation, penaltyType, flatFeeAmount);
    const noShowRecord = await tx.noShowRecord.create({
      data: { tenantId, reservationId: reservation.id, penaltyType, penaltyAmount, markedBy },
    });

    const folio = await this.foliosService.ensurePrimaryFolio(tx, updated, markedBy ?? reservation.createdBy ?? '');
    if (penaltyAmount && !penaltyAmount.isZero()) {
      await this.foliosService.postAdHocCharge(
        tx,
        updated,
        folio,
        'penalty',
        penaltyAmount,
        `No-Show Penalty (${penaltyType.replace('_', ' ')})`,
        markedBy ?? reservation.createdBy ?? '',
      );
    }
    await this.foliosService.settleIfFullyPaid(tx, folio, markedBy ?? reservation.createdBy ?? '', 'noShow');

    await this.audit(tx, tenantId, reservation.branchId, markedBy ?? 'system', 'reservation.no_show', reservation.id, {
      penaltyType,
      penaltyAmount: penaltyAmount?.toFixed(2) ?? null,
      auto: markedBy === null,
    });
    await this.commsLogService.logAutomatedInTx(tx, tenantId, reservation.branchId, {
      reservationId: reservation.id,
      guestId: updated.guestId,
      channel: 'email',
      subject: `Reservation Marked No-Show — ${updated.confirmationNumber}`,
      body: `We've marked your reservation ${updated.confirmationNumber} as a no-show.${
        penaltyAmount && !penaltyAmount.isZero() ? ` A penalty of ${penaltyAmount.toFixed(2)} was applied.` : ''
      }`,
      trigger: 'no_show_notice',
    });
    return { reservation: updated, noShowRecord };
  }

  /** Mirrors `NightAuditService`'s own (now-removed) private copy — moved here since it's a per-reservation concern both the manual and automated marking paths need identically. */
  private penaltyAmountFor(
    reservation: { confirmedRate: Prisma.Decimal; overrideRate: Prisma.Decimal | null; checkInDate: Date; checkOutDate: Date },
    penaltyType: PenaltyType,
    flatFeeAmount: number | undefined,
  ): Prisma.Decimal | null {
    const nights = Math.max(1, Math.round((reservation.checkOutDate.getTime() - reservation.checkInDate.getTime()) / 86_400_000));
    switch (penaltyType) {
      case 'first_night':
        return reservation.overrideRate
          ? new Prisma.Decimal(reservation.overrideRate)
          : new Prisma.Decimal(reservation.confirmedRate).div(nights).toDecimalPlaces(2);
      case 'full_stay':
        return new Prisma.Decimal(reservation.confirmedRate);
      case 'flat_fee':
        return flatFeeAmount ? new Prisma.Decimal(flatFeeAmount) : null;
      default:
        return null;
    }
  }

  /**
   * RBAC-gated at the controller (`@Roles(Owner, Manager)`) — reverses the
   * penalty charge as a NEW correction line item (never mutates the
   * original, same append-only discipline `FoliosService.correctLineItem`
   * uses), then re-checks whether the folio can now settle. Idempotent: a
   * second waive on an already-waived record is a no-op, not an error —
   * there's nothing left to reverse.
   */
  async waiveNoShowPenalty(tenantId: string, noShowRecordId: string, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const record = await tx.noShowRecord.findFirst({ where: { id: noShowRecordId } });
      if (!record) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'No-show record not found' });
      }
      return this.waiveNoShowPenaltyInTx(tx, tenantId, record, actorId);
    });
  }

  /**
   * Shared with `reinstateFromNoShow`, which already has its own open
   * transaction — calling the PUBLIC `waiveNoShowPenalty` from inside it
   * would open a second, independent `withTenant`/`$transaction` nested
   * inside the first, breaking atomicity (the waive could commit or fail
   * separately from the reinstatement) and risking a lock conflict against
   * the very rows the outer transaction is already holding. Same reason
   * `markNoShowInTx` exists alongside `markNoShow`.
   */
  private async waiveNoShowPenaltyInTx(tx: TenantTx, tenantId: string, record: NoShowRecord, actorId: string) {
    if (record.penaltyWaived) return record;

    const updated = await tx.noShowRecord.update({
      where: { id: record.id },
      data: { penaltyWaived: true, waivedBy: actorId, refundAmount: record.penaltyAmount },
    });

    const reservation = await this.findReservationOrThrow(tx, record.reservationId);
    if (record.penaltyAmount && !record.penaltyAmount.isZero()) {
      const folio = await this.foliosService.ensurePrimaryFolio(tx, reservation, actorId);
      await this.foliosService.postAdHocCharge(tx, reservation, folio, 'correction', record.penaltyAmount.negated(), 'No-Show Penalty Waived', actorId);
      await this.foliosService.settleIfFullyPaid(tx, folio, actorId, 'noShowWaived');
    }

    await this.audit(tx, tenantId, reservation.branchId, actorId, 'no_show.penalty_waived', record.id, {
      penaltyAmount: record.penaltyAmount?.toFixed(2) ?? null,
    });
    return updated;
  }

  /**
   * Late-arrival reinstatement (ref: "revised dates + optional penalty
   * reversal") — the guest's ORIGINAL check-in date has necessarily
   * already passed (that's what made this a no-show), so new dates are
   * mandatory, not optional the way `ModifyReservationDto`'s are.
   * Re-checks availability and re-resolves the rate for the new dates
   * exactly like Modify does — a reinstatement is a fresh booking in every
   * way except that it reuses the existing reservation row and guest.
   */
  async reinstateFromNoShow(tenantId: string, reservationId: string, dto: ReinstateNoShowDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.findReservationOrThrow(tx, reservationId);
      if (reservation.status !== 'no_show') {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `Cannot reinstate a reservation with status "${reservation.status}" — only a no-show can be`,
        });
      }
      const checkInDate = toBranchDate(dto.checkInDate);
      const checkOutDate = toBranchDate(dto.checkOutDate);
      this.assertValidRange(checkInDate, checkOutDate);
      const roomType = await this.assertRoomType(tx, reservation.branchId, reservation.roomTypeId);
      await this.assertAvailableForStay(tx, reservation.branchId, reservation.roomTypeId, checkInDate, checkOutDate, reservationId);

      const resolved = await this.rateResolverService.resolveStay(
        tx,
        tenantId,
        reservation.branchId,
        roomType,
        checkInDate,
        checkOutDate,
        {},
        { triggeredBy: 'modify', userId: actorId, reservationId },
      );

      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'confirmed', checkInDate, checkOutDate, ratePlanId: resolved.ratePlanId, confirmedRate: resolved.subtotal },
        include: RESERVATION_INCLUDE,
      });

      if (dto.waivePenalty) {
        const record = await tx.noShowRecord.findFirst({ where: { reservationId }, orderBy: { markedAt: 'desc' } });
        if (record && !record.penaltyWaived) {
          await this.waiveNoShowPenaltyInTx(tx, tenantId, record, actorId);
        }
      }

      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.reinstated', reservationId, {
        checkInDate: dto.checkInDate,
        checkOutDate: dto.checkOutDate,
        waivedPenalty: dto.waivePenalty ?? false,
      });
      return updated;
    });
  }

  /**
   * Modify Reservation (ref p23) — dates, room type, and party size, for a
   * reservation that hasn't happened yet. Deliberately restricted to
   * `confirmed`/`waitlisted`: a `checked_in` stay already has folio charges
   * posted against its original dates/rate (§4.5's append-only ledger), so
   * shortening or extending it needs charge corrections, not a plain field
   * update — a real, separate piece of work, explicitly deferred (see
   * PHASE_NOTES.md). A `checked_out`/`cancelled`/`no_show` reservation is
   * history, not something to edit.
   *
   * Every field is optional (only what's actually changing needs to be
   * sent), but a rate/availability change always re-derives from the
   * reservation's CURRENT stored values for anything not provided — never
   * from stale client-supplied echoes of them.
   */
  async modifyReservation(tenantId: string, reservationId: string, dto: ModifyReservationDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.findReservationOrThrow(tx, reservationId);
      if (!['confirmed', 'waitlisted'].includes(reservation.status)) {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `Cannot modify a reservation with status "${reservation.status}" — only confirmed or waitlisted reservations can be changed here`,
        });
      }

      const checkInDate = dto.checkInDate ? toBranchDate(dto.checkInDate) : reservation.checkInDate;
      const checkOutDate = dto.checkOutDate ? toBranchDate(dto.checkOutDate) : reservation.checkOutDate;
      this.assertValidRange(checkInDate, checkOutDate);
      const roomTypeId = dto.roomTypeId ?? reservation.roomTypeId;
      const roomType = await this.assertRoomType(tx, reservation.branchId, roomTypeId);

      const datesOrRoomTypeChanged =
        checkInDate.getTime() !== reservation.checkInDate.getTime() ||
        checkOutDate.getTime() !== reservation.checkOutDate.getTime() ||
        roomTypeId !== reservation.roomTypeId;
      // A waitlisted reservation holds no inventory (not in HOLDING_STATUSES),
      // so it never needs to pass this check against itself — but a
      // confirmed one is checked EXCLUDING its own current hold, so
      // shrinking a stay or nudging it by a day doesn't get rejected for
      // "conflicting" with the booking being changed.
      if (datesOrRoomTypeChanged && reservation.status === 'confirmed') {
        await this.assertAvailableForStay(tx, reservation.branchId, roomTypeId, checkInDate, checkOutDate, reservationId);
      }

      // Re-resolves through the base/cascade tiers only — a promo code or
      // negotiated corporate rate applied at original booking is NOT
      // reapplied here (ModifyReservationDto carries neither), so a
      // discounted booking loses that discount on modify. Carrying the
      // original override forward across a date/room-type change is a real
      // gap, deliberately deferred rather than half-built — see
      // PHASE_NOTES.md.
      const resolved = await this.rateResolverService.resolveStay(
        tx,
        tenantId,
        reservation.branchId,
        roomType,
        checkInDate,
        checkOutDate,
        {},
        { triggeredBy: 'modify', userId: actorId, reservationId },
      );

      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: {
          checkInDate,
          checkOutDate,
          roomTypeId,
          ratePlanId: resolved.ratePlanId,
          confirmedRate: resolved.subtotal,
          adults: dto.adults ?? reservation.adults,
          children: dto.children ?? reservation.children,
        },
        include: RESERVATION_INCLUDE,
      });

      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.modified', reservationId, {
        reason: dto.reason,
        before: { checkInDate: reservation.checkInDate, checkOutDate: reservation.checkOutDate, roomTypeId: reservation.roomTypeId, confirmedRate: reservation.confirmedRate.toFixed(2) },
        after: { checkInDate, checkOutDate, roomTypeId, confirmedRate: resolved.subtotal.toFixed(2) },
      });
      return updated;
    });
  }

  /**
   * Waitlist Management's "Promote" action — re-checks availability for the
   * reservation's own dates/room type and, if a room has since opened up,
   * flips it to `confirmed`. Throws `RESERVATION_NOT_AVAILABLE` (same code
   * a normal booking attempt throws) if nothing has opened up yet — the
   * caller stays waitlisted, nothing changes.
   */
  async promoteFromWaitlist(tenantId: string, reservationId: string, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.findReservationOrThrow(tx, reservationId);
      if (reservation.status !== 'waitlisted') {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `Cannot promote a reservation with status "${reservation.status}" — only a waitlisted one can be promoted`,
        });
      }
      await this.assertAvailableForStay(tx, reservation.branchId, reservation.roomTypeId, reservation.checkInDate, reservation.checkOutDate);
      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'confirmed' },
        include: RESERVATION_INCLUDE,
      });
      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.promoted', reservationId);
      return updated;
    });
  }

  /**
   * Overbooking's walk flow (ref: "Record walk — relocation, compensation,
   * auto-cancel + refund") — the guest whose room genuinely isn't there at
   * arrival, relocated to another property. Sets status `walked`, not
   * `cancelled` — `ReservationStatus` already has its own dedicated value
   * for exactly this (the reference's prose says "auto-cancel" loosely;
   * the schema's own enum is more precise, and a walked guest is a
   * meaningfully different outcome from a plain cancellation for
   * reporting). Restricted to `confirmed`: walking someone already
   * `checked_in` is a mid-stay room-change problem, a different (unbuilt)
   * flow, not this one.
   *
   * "Refund" reverses whatever was actually paid — one negative `Payment`
   * per original payment, same method/currency, never a blind lump sum.
   * In THIS system's current data that's usually nothing: payment/deposit
   * at booking time isn't built yet (named in the Reservations phase's own
   * carried-forward list), so a `confirmed` reservation essentially never
   * has a folio yet. The check is still correct, not dead code — it just
   * rarely fires today, and starts mattering the moment deposit-at-booking
   * lands.
   */
  async walkReservation(tenantId: string, reservationId: string, dto: WalkReservationDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.findReservationOrThrow(tx, reservationId);
      if (reservation.status !== 'confirmed') {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `Cannot walk a reservation with status "${reservation.status}" — only a confirmed reservation (not yet arrived) can be`,
        });
      }

      const walkRecord = await tx.walkRecord.create({
        data: {
          tenantId,
          reservationId,
          relocationProperty: dto.relocationProperty,
          transportProvided: dto.transportProvided ?? false,
          transportCost: dto.transportCost !== undefined ? new Prisma.Decimal(dto.transportCost) : null,
          compensationOffered: dto.compensationOffered,
          approvedBy: actorId,
        },
      });

      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'walked' },
        include: RESERVATION_INCLUDE,
      });

      const folio = await tx.folio.findFirst({ where: { reservationId, deletedAt: null } });
      let refundedTotal = new Prisma.Decimal(0);
      if (folio) {
        const payments = await tx.payment.findMany({ where: { folioId: folio.id, isVoid: false, amount: { gt: 0 } } });
        for (const payment of payments) {
          await tx.payment.create({
            data: {
              tenantId,
              folioId: folio.id,
              method: payment.method,
              amount: payment.amount.negated(),
              currency: payment.currency,
              paymentPurpose: 'payment',
              reference: `Walk refund — reversing payment ${payment.id}`,
              recordedBy: actorId,
            },
          });
          refundedTotal = refundedTotal.add(payment.amount);
        }
      }

      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.walked', reservationId, {
        relocationProperty: dto.relocationProperty,
        refundedTotal: refundedTotal.toFixed(2),
      });
      return { reservation: updated, walkRecord, refundedTotal: refundedTotal.toFixed(2) };
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

  /**
   * The general search/filter behind Modify Reservation, Cancel
   * Reservation, and Waitlist Management's "find the reservation" step,
   * and the Reservations hub's own stat cards — the one thing "Reservations"
   * being a sidebar item with no page behind it was missing since Phase 24.
   * Capped at 100 rows: a real search field, not a full-table browse.
   */
  async listReservations(tenantId: string, branchId: string, dto: ListReservationsQueryDto) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const search = dto.search?.trim();
      return tx.reservation.findMany({
        where: {
          branchId,
          deletedAt: null,
          ...(dto.status ? { status: dto.status } : {}),
          ...(search
            ? {
                OR: [
                  { confirmationNumber: { contains: search, mode: 'insensitive' } },
                  { guest: { name: { contains: search, mode: 'insensitive' } } },
                ],
              }
            : {}),
        },
        include: RESERVATION_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 100,
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
    excludeReservationId?: string,
  ): Promise<void> {
    const perNight = await this.computeAvailabilityPerNight(tx, branchId, roomTypeId, checkInDate, checkOutDate, excludeReservationId);
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

  /**
   * `confirmationNumber` is unique per TENANT (`@@unique([tenantId,
   * confirmationNumber])`), not globally — it used to be a bare `@unique`,
   * which was a real bug: this collision check runs under the caller's own
   * tenant context, so RLS hides every other tenant's rows from it. On a
   * shared DB with many tenants, a low-activity branch's first few
   * candidates (RES-2026-00001, 00002, …) reliably already belonged to some
   * OTHER tenant — invisible to this `findUnique`, but still hit by the
   * real global index underneath, so every "verified free" candidate
   * collided on insert anyway, deterministically, not as a rare race. The
   * actual `create()` call is ALSO wrapped in a retry loop (see
   * `createReservationRow`) as defense against the TOCTOU window between
   * this probe and the real insert — that part was always correct.
   */
  private async generateConfirmationNumber(tx: TenantTx, tenantId: string, branchId: string): Promise<string> {
    const year = new Date().getFullYear();
    const count = await tx.reservation.count({ where: { branchId } });
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `RES-${year}-${String(count + 1 + attempt).padStart(5, '0')}`;
      const clash = await tx.reservation.findUnique({ where: { tenantId_confirmationNumber: { tenantId, confirmationNumber: candidate } } });
      if (!clash) return candidate;
    }
    throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'Could not generate a unique confirmation number' });
  }

  /**
   * A `SAVEPOINT` per attempt — not optional. Postgres aborts the ENTIRE
   * surrounding transaction the instant any statement inside it fails
   * (a unique-constraint violation included); every later statement on
   * that same transaction then errors with `25P02 "current transaction is
   * aborted"`, no matter how unrelated it is. Without the savepoint here,
   * catching the `P2002` from a confirmation-number collision and then
   * calling `generateConfirmationNumber` again — which issues its own
   * `count`/`findUnique` queries on the SAME transaction — was guaranteed
   * to fail with that exact 25P02, not a second, cleaner collision retry.
   * Found live: a genuine collision under real concurrent bookings hit
   * this path, and the retry itself was what broke, not the collision.
   * `ROLLBACK TO SAVEPOINT` undoes only the failed insert, leaving the
   * outer `withTenant` transaction healthy for the retry's own queries and
   * for whatever the caller does next.
   */
  private async createReservationRow(tx: TenantTx, data: Prisma.ReservationUncheckedCreateInput) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await tx.$executeRawUnsafe('SAVEPOINT create_reservation_attempt');
      try {
        const created = await tx.reservation.create({ data, include: RESERVATION_INCLUDE });
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT create_reservation_attempt');
        return created;
      } catch (error) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT create_reservation_attempt');
        const isUniqueViolation = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        // A non-collision failure (a real connection error, a different
        // constraint) is someone else's problem — rethrow it verbatim, not
        // wrapped, so it isn't mistaken for "ran out of confirmation
        // numbers to try". Only a genuine exhausted-retries collision gets
        // the app's own clean error; the raw Prisma error was leaking
        // straight to callers before this.
        if (!isUniqueViolation) throw error;
        if (attempt === 2) {
          throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'Could not create reservation' });
        }
        data.confirmationNumber = await this.generateConfirmationNumber(tx, data.tenantId, data.branchId);
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
