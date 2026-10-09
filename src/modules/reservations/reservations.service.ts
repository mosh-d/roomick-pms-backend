import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Branch, NoShowRecord, PenaltyType, Prisma, Reservation, Room, RoomType } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { hasPassedBranchCutoff, timeOfDay, todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { RoomsService } from '../property/rooms.service';
import { GuestsService } from '../guests/guests.service';
import { CreateGuestDto } from '../guests/dto/guest.dto';
import { FoliosService } from '../folios/folios.service';
import { RefundsService } from '../folios/refunds.service';
import { TaxesService } from '../taxes/taxes.service';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { MAX_STAY_NIGHTS, RateResolverService, StayResolution } from '../rate-resolver/rate-resolver.service';
import { outsideGroupBlock } from '../sales-events/group-block-window';
import { RegistrationCardsService } from '../registration-cards/registration-cards.service';
import { CommsLogService } from '../comms-log/comms-log.service';
import { RestrictionsService } from '../revenue-management/restrictions.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { WebhookEventsService } from '../integrations/webhook-events.service';
import {
  CANCELLABLE_STATUSES,
  CancellationQuote,
  PENALTY_LABELS,
  cancellationTermsFor,
  describeCancellationPolicy,
  penaltyAmountFor,
  resolveCancellationPolicy,
} from './policies';
import { manageBookingLine } from './guest-links';
import { bookingConfirmationBody } from './guest-messages';
import {
  AvailabilityCalendarQueryDto,
  AvailabilityQueryDto,
  CancelReservationDto,
  CancelWithWaiverDto,
  CheckInDto,
  CreateReservationDto,
  ExtendStayDto,
  GroupCheckInDto,
  ListReservationsQueryDto,
  ModifyReservationDto,
  ReinstateNoShowDto,
  SetRateOverrideDto,
  WalkInReservationDto,
  WalkReservationDto,
} from './dto/reservation.dto';

/** Each night's own price as resolved — kept on the stay so every night is billed at what it was quoted, not the total split evenly. */
const nightlyRatesOf = (resolved: StayResolution): Prisma.InputJsonValue => resolved.perNight.map((night) => ({ date: night.date, rate: night.finalRate }));

const RESERVATION_INCLUDE = {
  // VIP level for the badge on Arrivals and the In-House list (ref: "VIP / group badge").
  guest: { select: { id: true, name: true, email: true, phone: true, vipLevel: true } },
  roomType: { select: { id: true, name: true } },
  room: { select: { id: true, number: true } },
  // The group a stay was booked into, for the same lists' Group column.
  groupBlock: { select: { id: true, name: true } },
  // The check-in night's winning plan only — see `RateResolverService
  // .resolveStay`'s own comment on why a single FK can't represent a stay
  // whose rate changes mid-week. NULL when the stay resolved to the plain
  // base rate (no cascade/override plan applied).
  ratePlan: { select: { id: true, name: true, type: true } },
  // The company a corporate stay is booked under.
  corporateAccount: { select: { id: true, name: true } },
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

/** The longest stay, and the longest availability window — one limit, shared with the rate resolver's quotes. */
const MAX_AVAILABILITY_RANGE_DAYS = MAX_STAY_NIGHTS;

/** Reservation statuses that hold inventory against a room type (§4.2). */
const HOLDING_STATUSES = ['confirmed', 'checked_in'] as const;

/** How a no-show penalty line starts on the bill — also how a waiver finds one posted before records linked their line. */
const NO_SHOW_PENALTY_LABEL = 'No-Show Penalty';

/** An overstaying guest's stay, for inventory: open-ended until they check out or the stay is extended. */
const OPEN_ENDED = new Date('9999-12-31T00:00:00.000Z');

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
    private readonly restrictionsService: RestrictionsService,
    private readonly loyaltyService: LoyaltyService,
    private readonly webhookEvents: WebhookEventsService,
    private readonly taxesService: TaxesService,
    private readonly refundsService: RefundsService,
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
   * Every active room type at the branch, per-night, across an ARBITRARY date
   * range — the Direct Booking Engine's shape ("what can I book for these
   * dates?"), where `getAvailability` above answers only for one already-
   * chosen room type and `getAvailabilityCalendar` below is locked to a whole
   * calendar month.
   *
   * Loops `computeAvailabilityPerNight` per room type inside a SINGLE
   * transaction for the same reason `getAvailabilityCalendar` does (see its
   * own comment): a branch has single-digit room types in practice, and
   * reusing the already-correct, already-tested per-room-type logic beats a
   * riskier combined rewrite. One transaction matters more here than
   * internally — this runs on an unauthenticated, frequently-hit public
   * endpoint.
   */
  async getAvailabilityForRange(tenantId: string, branchId: string, from: Date, to: Date) {
    this.assertValidRange(from, to);
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const roomTypes = await tx.roomType.findMany({
        where: { branchId, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      return Promise.all(
        roomTypes.map(async (roomType) => ({
          roomTypeId: roomType.id,
          roomTypeName: roomType.name,
          nights: await this.computeAvailabilityPerNight(tx, branchId, roomType.id, from, to),
        })),
      );
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
          const reservations = await this.holdingStays(tx, branchId, roomType.id, from, to);
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
   *
   * Group blocks come off the top the same way: rooms a block still holds
   * for its group (see `groupBlockHolds`) aren't for sale to anyone else.
   * `bookingIntoBlockId` is a booking made FOR that group, which may take
   * the block's own held rooms.
   */
  private async computeAvailabilityPerNight(
    tx: TenantTx,
    branchId: string,
    roomTypeId: string,
    from: Date,
    to: Date,
    excludeReservationId?: string,
    bookingIntoBlockId?: string,
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

    // Modifying a reservation re-checks availability for its (possibly
    // unchanged) dates — without the exclusion, the reservation would count
    // as occupying a room against itself, wrongly reporting no availability
    // for a change that doesn't actually need a new room.
    const reservations = await this.holdingStays(tx, branchId, roomTypeId, from, to, excludeReservationId);

    const overbookingConfigs = await tx.overbookingConfig.findMany({ where: { branchId, OR: [{ roomTypeId }, { roomTypeId: null }] } });
    const roomTypeConfig = overbookingConfigs.find((c) => c.roomTypeId === roomTypeId);
    const branchConfig = overbookingConfigs.find((c) => c.roomTypeId === null);
    const heldForGroups = await this.groupBlockHolds(tx, branchId, roomTypeId, from, to, bookingIntoBlockId);

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
      const date = night.toISOString().slice(0, 10);
      const available = Math.max(0, capacity - reservedCount - (heldForGroups.get(date) ?? 0));
      return { date, available };
    });
  }

  /**
   * The stays holding a room type's rooms across `[from, to)`. A guest still
   * checked in after their departure has passed keeps the room every night
   * until they check out or the stay is extended — their stay is returned
   * open-ended. Otherwise the room went back on sale the moment the old date
   * passed, with the guest still in it, and the next booking for that night
   * had nowhere to sleep (the in-house PMS's own rule).
   *
   * "Passed" is the branch's own check-out time on the departure day, the
   * same moment the Alerts page starts calling the guest overdue.
   */
  private async holdingStays(
    tx: TenantTx,
    branchId: string,
    roomTypeId: string,
    from: Date,
    to: Date,
    excludeReservationId?: string,
  ): Promise<Array<{ checkInDate: Date; checkOutDate: Date }>> {
    const stays = await tx.reservation.findMany({
      where: {
        branchId,
        roomTypeId,
        deletedAt: null,
        status: { in: [...HOLDING_STATUSES] },
        checkInDate: { lt: to },
        // Everyone in-house is a candidate however old their departure date;
        // whether they're actually overstaying is decided below.
        OR: [{ checkOutDate: { gt: from } }, { status: 'checked_in' }],
        ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
      },
      select: { checkInDate: true, checkOutDate: true, status: true },
    });

    const now = new Date();
    const mayBeOverdue = stays.some((stay) => stay.status === 'checked_in' && stay.checkOutDate.getTime() <= now.getTime() + 86_400_000);
    const branch = mayBeOverdue ? await tx.branch.findFirst({ where: { id: branchId }, select: { timezone: true, checkOutTime: true } }) : null;
    const overdue = (stay: { status: string; checkOutDate: Date }) =>
      !!branch && stay.status === 'checked_in' && hasPassedBranchCutoff(stay.checkOutDate, timeOfDay(branch.checkOutTime), branch.timezone, now);

    return stays
      .map((stay) => ({ checkInDate: stay.checkInDate, checkOutDate: overdue(stay) ? OPEN_ENDED : stay.checkOutDate }))
      .filter((stay) => stay.checkOutDate > from);
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

  /**
   * Rooms group blocks are still holding, per night (`YYYY-MM-DD` → rooms).
   * An active block with stay dates holds, on each night of its stay, its
   * allotment minus the block's own bookings that night — but never more
   * than the bookings it can still take (allotment minus its whole pickup),
   * so a member leaving a night early doesn't keep a room off sale that no
   * one in the group can book. Once the cut-off date has passed in the
   * branch's timezone the hold simply stops counting: the unbooked rooms are
   * back on sale with no job to run. A block made before holds existed has
   * no stay dates and holds nothing.
   */
  private async groupBlockHolds(
    tx: TenantTx,
    branchId: string,
    roomTypeId: string,
    from: Date,
    to: Date,
    bookingIntoBlockId?: string,
  ): Promise<Map<string, number>> {
    const held = new Map<string, number>();
    const blocks = await tx.groupBlock.findMany({
      where: {
        branchId,
        roomTypeId,
        status: 'active',
        arrivalDate: { lt: to },
        departureDate: { gt: from },
        ...(bookingIntoBlockId ? { id: { not: bookingIntoBlockId } } : {}),
      },
      select: { id: true, blockSize: true, arrivalDate: true, departureDate: true, cutoffDate: true },
    });
    if (blocks.length === 0) return held;

    const branch = await tx.branch.findFirst({ where: { id: branchId }, select: { timezone: true } });
    const today = toBranchDate(todayInTimezone(branch?.timezone ?? 'UTC'));
    const holding = blocks.filter((b) => b.cutoffDate >= today);
    if (holding.length === 0) return held;

    const blockIds = holding.map((b) => b.id);
    const booked = await tx.reservation.findMany({
      where: {
        groupBlockId: { in: blockIds },
        deletedAt: null,
        status: { in: [...HOLDING_STATUSES] },
        checkInDate: { lt: to },
        checkOutDate: { gt: from },
      },
      select: { groupBlockId: true, checkInDate: true, checkOutDate: true },
    });
    // The same statuses `assertGroupBlockOpen` counts toward a full block.
    const pickups = await tx.reservation.groupBy({
      by: ['groupBlockId'],
      where: { groupBlockId: { in: blockIds }, deletedAt: null, status: { in: ['confirmed', 'checked_in', 'checked_out'] } },
      _count: { _all: true },
    });
    const pickupByBlock = new Map(pickups.map((p) => [p.groupBlockId, p._count._all]));

    for (const night of this.enumerateNights(from, to)) {
      let rooms = 0;
      for (const block of holding) {
        if (!block.arrivalDate || !block.departureDate || block.arrivalDate > night || block.departureDate <= night) continue;
        const bookedTonight = booked.filter((r) => r.groupBlockId === block.id && r.checkInDate <= night && r.checkOutDate > night).length;
        const stillBookable = block.blockSize - (pickupByBlock.get(block.id) ?? 0);
        rooms += Math.max(0, Math.min(block.blockSize - bookedTonight, stillBookable));
      }
      if (rooms > 0) held.set(night.toISOString().slice(0, 10), rooms);
    }
    return held;
  }

  /** Per-night availability inside the caller's transaction — creating a group block checks it only holds rooms that are free. */
  async availabilityPerNightInTx(tx: TenantTx, branchId: string, roomTypeId: string, from: Date, to: Date) {
    return this.computeAvailabilityPerNight(tx, branchId, roomTypeId, from, to);
  }

  /**
   * Booking into a group block: the block must be open, for this room type,
   * and not yet full. Runs after the caller's room-type lock, so two bookings
   * can't both take the block's last room.
   */
  private async assertGroupBlockOpen(tx: TenantTx, groupBlockId: string, branchId: string, roomTypeId: string) {
    const block = await tx.groupBlock.findFirst({ where: { id: groupBlockId, branchId } });
    if (!block) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Group block not found' });
    }
    if (block.status !== 'active') {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: `This block is ${block.status}, not accepting reservations` });
    }
    if (block.roomTypeId !== roomTypeId) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'A group block books only its own room type' });
    }
    const pickup = await tx.reservation.count({
      where: { groupBlockId, deletedAt: null, status: { in: ['confirmed', 'checked_in', 'checked_out'] } },
    });
    if (pickup >= block.blockSize) {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: `This block's full allotment of ${block.blockSize} rooms is already booked` });
    }
    return block;
  }

  /**
   * Serialises every availability check for one room type: two bookings,
   * moves, extensions or walk-ins racing for the last room queue here
   * instead of both passing. Only new bookings took this lock before.
   */
  private async lockRoomType(tx: TenantTx, roomTypeId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM room_types WHERE id = ${roomTypeId}::uuid FOR UPDATE`;
  }

  /** The same for one physical room — two desks walking guests into, or moving guests to, the same room. */
  private async lockRoom(tx: TenantTx, roomId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${roomId}::uuid FOR UPDATE`;
  }

  /**
   * What a re-dated stay is recorded at. A stay with a nightly rate pinned —
   * its group block's, or a manager's override — is billed that rate every
   * night (the folio posts `overrideRate`), so that is what its total says;
   * re-pricing it at the public rate on a date change left the record, the
   * registration card and the reports showing a price nobody was charged.
   * Anything else takes the resolver's price for the new dates.
   */
  private async repricedStay(
    tx: TenantTx,
    reservation: { branchId: string; overrideRate: Prisma.Decimal | null },
    resolved: StayResolution,
    checkInDate: Date,
    checkOutDate: Date,
  ): Promise<{ subtotal: Prisma.Decimal; nightlyRates: ReturnType<typeof nightlyRatesOf> }> {
    if (!reservation.overrideRate) return { subtotal: resolved.subtotal, nightlyRates: nightlyRatesOf(resolved) };
    const pinned = await this.blockPricing(tx, reservation.branchId, reservation.overrideRate, checkInDate, checkOutDate);
    return { subtotal: pinned.subtotal, nightlyRates: pinned.nightlyRates };
  }

  /** A group booking stays one: its block's room type, and its block's nights (give or take the shoulder nights). */
  private async assertStaysInGroupBlock(tx: TenantTx, groupBlockId: string, roomTypeId: string, checkInDate: Date, checkOutDate: Date): Promise<void> {
    const block = await tx.groupBlock.findFirst({ where: { id: groupBlockId }, select: { roomTypeId: true, arrivalDate: true, departureDate: true } });
    if (!block) return;
    if (block.roomTypeId !== roomTypeId) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: "A group booking stays in its block's room type" });
    }
    const outside = outsideGroupBlock(block, checkInDate.toISOString().slice(0, 10), checkOutDate.toISOString().slice(0, 10));
    if (outside) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `A group booking keeps to its block's nights: ${outside}` });
    }
  }

  /**
   * A group block's own nightly rate for every night of the stay, with the
   * branch's room tax on top — the same arithmetic the folio applies when
   * the nights post (`priceCharge` taxes the stay's total; `units` only
   * scales a fixed per-night tax).
   */
  private async blockPricing(tx: TenantTx, branchId: string, blockRate: Prisma.Decimal, checkInDate: Date, checkOutDate: Date) {
    const nights = this.enumerateNights(checkInDate, checkOutDate);
    const nightly = new Prisma.Decimal(blockRate);
    const priced = await this.taxesService.priceCharge(tx, branchId, 'room', nightly.mul(nights.length), nights.length);
    return {
      subtotal: priced.price,
      taxTotal: priced.addedTax,
      totalWithTax: priced.total,
      nightlyRates: nights.map((night) => ({ date: night.toISOString().slice(0, 10), rate: nightly.toFixed(2) })),
    };
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
  /**
   * `actorId: null` is a guest self-booking through the Direct Booking Engine
   * — there is no staff user to attribute. `Reservation.createdBy` was
   * declared nullable at P0 for exactly this ("NULL = online booking", see
   * schema.prisma), as was `AuditLog.userId` ("NULL = system action"), so
   * this widening needed no migration. Every other caller is unchanged.
   */
  async createReservation(
    tenantId: string,
    branchId: string,
    dto: CreateReservationDto,
    actorId: string | null,
    /** `publicBooking`: made on the public booking page — the guest is matched as `GuestsService.publicBookingGuest` says. */
    options: { groupBlockId?: string; publicBooking?: boolean } = {},
  ) {
    const checkInDate = toBranchDate(dto.checkInDate);
    const checkOutDate = toBranchDate(dto.checkOutDate);
    this.assertValidRange(checkInDate, checkOutDate);
    const guestInput = this.resolveGuestInput(dto);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const roomType = await this.assertRoomType(tx, branchId, dto.roomTypeId);
      this.assertWithinCapacity(roomType, dto.adults, dto.children ?? 0);
      // Additive — a tenant with no configured restriction sees zero
      // behavior change; a match throws the SAME RESERVATION_NOT_AVAILABLE
      // conflict the plain availability check below already uses.
      await this.restrictionsService.assertNoViolation(tx, branchId, dto.roomTypeId, checkInDate, checkOutDate);
      const guest = await this.guestsService.findOrCreateGuestInTx(tx, tenantId, guestInput, { publicBooking: options.publicBooking });

      // Serializes concurrent creates for the SAME room type only — closes
      // the common "double-book the last room" race without needing a
      // specific room to lock (none is assigned until check-in).
      await this.lockRoomType(tx, dto.roomTypeId);
      // `joinWaitlist` is an explicit request to skip the availability
      // check, not an automatic fallback — a plain booking that finds no
      // rooms still throws `RESERVATION_NOT_AVAILABLE`, same as before.
      const block = options.groupBlockId ? await this.assertGroupBlockOpen(tx, options.groupBlockId, branchId, dto.roomTypeId) : null;
      if (!dto.joinWaitlist) {
        await this.assertAvailableForStay(tx, branchId, dto.roomTypeId, checkInDate, checkOutDate, undefined, block?.id);
      }

      const deal = await this.dealTerms(tx, dto);
      const resolved = await this.rateResolverService.resolveStay(
        tx,
        tenantId,
        branchId,
        roomType,
        checkInDate,
        checkOutDate,
        deal,
        { triggeredBy: 'booking_create', userId: actorId ?? undefined },
      );
      // A group booking is priced at its block's rate for every night — that is
      // what the folio posts (`overrideRate`), so it is also what the record
      // says. `confirmedRate` and `nightlyRates` used to keep the public quote,
      // and stay history, custom reports and the registration card showed a
      // price the guest was never charged. Tax follows the branch's rules
      // either way; the confirmation used to say "tax 0" for a group booking.
      const pricing = block
        ? await this.blockPricing(tx, branchId, block.blockRate, checkInDate, checkOutDate)
        : { subtotal: resolved.subtotal, taxTotal: resolved.taxTotal, totalWithTax: resolved.totalWithTax, nightlyRates: nightlyRatesOf(resolved) };
      const confirmationNumber = await this.generateConfirmationNumber(tx, tenantId);

      const reservation = await this.createReservationRow(tx, {
        tenantId,
        branchId,
        guestId: guest.id,
        roomTypeId: dto.roomTypeId,
        ratePlanId: resolved.ratePlanId,
        corporateAccountId: deal.corporateAccountId,
        promoCode: deal.promoCode,
        confirmationNumber,
        confirmedRate: pricing.subtotal,
        nightlyRates: pricing.nightlyRates,
        status: dto.joinWaitlist ? 'waitlisted' : 'confirmed',
        channel: dto.channel ?? 'direct',
        checkInDate,
        checkOutDate,
        adults: dto.adults,
        children: dto.children ?? 0,
        specialRequests: dto.specialRequests,
        createdBy: actorId,
        // A group booking is linked to its block in the same transaction and
        // takes the block's rate as its nightly override — the field a
        // manager's rate override writes.
        groupBlockId: block?.id,
        overrideRate: block?.blockRate,
        overrideReason: block ? `Group block: ${block.name}` : undefined,
        // The terms this booking is made under — resolved, so a branch still on
        // the default gets the default written down. A later policy change
        // doesn't reach back into bookings already taken.
        cancellationPolicy: { ...resolveCancellationPolicy(branch.cancellationPolicy) },
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
          // A group booking is billed at the block's rate, not the resolver's quote.
          body: bookingConfirmationBody({
            guestName: guest.name,
            confirmationNumber,
            branch,
            roomTypeName: roomType.name,
            checkInDate: dto.checkInDate,
            checkOutDate: dto.checkOutDate,
            adults: dto.adults,
            children: dto.children ?? 0,
            subtotal: pricing.subtotal,
            taxTotal: pricing.taxTotal,
            total: pricing.totalWithTax,
          }),
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
      this.assertWithinCapacity(roomType, dto.adults, dto.children ?? 0);
      // The same gates an advance booking passes: stop-sell and length-of-stay
      // restrictions, and the room-type pool for the WHOLE stay. A room that is
      // physically free tonight may already be promised to tomorrow's
      // arrivals — walking a guest into it for three nights overbooked them.
      await this.restrictionsService.assertNoViolation(tx, branchId, dto.roomTypeId, checkInDate, checkOutDate);
      const guest = await this.guestsService.findOrCreateGuestInTx(tx, tenantId, guestInput);

      await this.lockRoomType(tx, dto.roomTypeId);
      await this.lockRoom(tx, dto.roomId);
      const room = await tx.room.findFirst({ where: { id: dto.roomId, deletedAt: null } });
      if (!room) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room not found' });
      }
      await this.assertRoomCheckInReady(tx, room, branchId, dto.roomTypeId, checkInDate, checkOutDate);
      await this.assertAvailableForStay(tx, branchId, dto.roomTypeId, checkInDate, checkOutDate);

      const deal = await this.dealTerms(tx, dto);
      const resolved = await this.rateResolverService.resolveStay(
        tx,
        tenantId,
        branchId,
        roomType,
        checkInDate,
        checkOutDate,
        deal,
        { triggeredBy: 'walkin', userId: actorId },
      );
      const confirmationNumber = await this.generateConfirmationNumber(tx, tenantId);

      const reservation = await this.createReservationRow(tx, {
        tenantId,
        branchId,
        guestId: guest.id,
        roomTypeId: dto.roomTypeId,
        roomId: dto.roomId,
        ratePlanId: resolved.ratePlanId,
        corporateAccountId: deal.corporateAccountId,
        promoCode: deal.promoCode,
        confirmationNumber,
        confirmedRate: resolved.subtotal,
        nightlyRates: nightlyRatesOf(resolved),
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
        body: `Welcome! You're checked in to room ${room.number} (${roomType.name}). Check-out is ${dto.checkOutDate}.${manageBookingLine(branch, confirmationNumber)}`,
        trigger: 'checkin_receipt',
      });
      return reservation;
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  async checkIn(tenantId: string, reservationId: string, dto: CheckInDto, actorId: string) {
    return this.prisma.withTenant(tenantId, (tx) => this.checkInInTx(tx, tenantId, reservationId, dto, actorId));
  }

  /** `checkIn` inside a caller's transaction — group check-in checks a whole group in through here, all or none. */
  async checkInInTx(tx: TenantTx, tenantId: string, reservationId: string, dto: CheckInDto, actorId: string) {
    const reservation = await this.findReservationOrThrow(tx, reservationId);
    if (reservation.status !== 'confirmed') {
      throw new ConflictException({
        code: ErrorCode.INVALID_STATUS_TRANSITION,
        message: `Cannot check in a reservation with status "${reservation.status}"`,
      });
    }
    // Check-in is for the arrival day. Early, the room went occupied now
    // while only the booked arrival night was posted — the nights until then
    // neither billed nor checked against availability. The stay's dates are
    // moved first (Modify Reservation), which prices and holds them.
    const branch = await this.propertyService.assertBranch(tx, reservation.branchId);
    const today = toBranchDate(todayInTimezone(branch.timezone));
    if (today < reservation.checkInDate) {
      throw new ConflictException({
        code: ErrorCode.EARLY_CHECK_IN,
        message: `This stay arrives on ${reservation.checkInDate.toISOString().slice(0, 10)} — to check the guest in today, move the arrival date first so the nights until then are priced and the room is held`,
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

    // Manual Room Override (ref: "Receptionist selects room manually"): a
    // room of another type, with the reason on record. The stay moves to
    // that type — so its inventory is counted where the guest really is —
    // at the rate they booked, pinned so a later extension can't re-price
    // it at the new type. The new type needs a room to spare for the stay.
    const overrideReason = dto.overrideReason?.trim() || undefined;
    const typeChanges = room.roomTypeId !== reservation.roomTypeId;
    let override: Prisma.ReservationUncheckedUpdateInput = {};
    if (typeChanges && room.branchId === reservation.branchId) {
      const [booked, given] = await Promise.all([
        this.assertRoomType(tx, reservation.branchId, reservation.roomTypeId),
        this.assertRoomType(tx, reservation.branchId, room.roomTypeId),
      ]);
      if (!overrideReason) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: `Room ${room.number} is a ${given.name} and this booking is for a ${booked.name} — give the reason for the override, or pick a ${booked.name} room`,
        });
      }
      await this.assertAvailableForStay(tx, reservation.branchId, room.roomTypeId, reservation.checkInDate, reservation.checkOutDate, reservationId);
      override = {
        roomTypeId: room.roomTypeId,
        ...(reservation.overrideRate
          ? {}
          : {
              overrideRate: new Prisma.Decimal(reservation.confirmedRate).div(this.stayNights(reservation)).toDecimalPlaces(2),
              overrideReason: `Given a ${given.name} at check-in at the booked rate — ${overrideReason}`.slice(0, 500),
            }),
      };
    }
    await this.assertRoomCheckInReady(tx, room, reservation.branchId, typeChanges ? room.roomTypeId : reservation.roomTypeId, reservation.checkInDate, reservation.checkOutDate);

    const updated = await tx.reservation.update({
      where: { id: reservationId },
      data: { status: 'checked_in', roomId, actualCheckIn: new Date(), ...override },
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
    await this.registrationCardsService.generateCardInTx(tx, tenantId, { ...updated, branch: { currency: updated.branch.currency, regCardTemplate: branch.regCardTemplate } }, actorId);

    await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.checked_in', reservationId, {
      roomId,
      ...(overrideReason ? { overrideReason } : {}),
      ...(typeChanges ? { bookedRoomTypeId: reservation.roomTypeId, roomTypeId: room.roomTypeId } : {}),
    });
    await this.commsLogService.logAutomatedInTx(tx, tenantId, reservation.branchId, {
      reservationId,
      guestId: updated.guestId,
      channel: 'email',
      subject: `Welcome — ${updated.confirmationNumber}`,
      body: `Welcome! You're checked in to room ${room.number} (${updated.roomType.name}). Check-out is ${updated.checkOutDate.toISOString().slice(0, 10)}.${manageBookingLine(branch, updated.confirmationNumber)}`,
      trigger: 'checkin_receipt',
    });
    return updated;
  }

  /**
   * Group check-in — a group block's arrivals checked in together, each
   * into the room the desk gives them, all or none: one room that turns out
   * to be taken leaves the whole group to try again, never half of it in.
   *
   * **Master bill** (optional): the group's room nights go on one bill on
   * the lead guest's stay, paid by the group's organiser (the block's
   * contact). Each guest's incidentals stay on their own bill. Every guest
   * in this check-in is routed to it (`billToFolioId`), from tonight's night
   * on — the arrival night included.
   */
  async checkInGroup(tenantId: string, blockId: string, dto: GroupCheckInDto, actorId: string) {
    const reservationIds = dto.assignments.map((a) => a.reservationId);
    const roomIds = dto.assignments.map((a) => a.roomId);
    if (new Set(reservationIds).size !== reservationIds.length) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'A guest is listed twice' });
    }
    if (new Set(roomIds).size !== roomIds.length) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Two guests have the same room — give each their own' });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const block = await tx.groupBlock.findFirst({ where: { id: blockId } });
      if (!block) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Group block not found' });
      const members = await tx.reservation.findMany({ where: { id: { in: reservationIds }, groupBlockId: blockId, deletedAt: null }, select: { id: true } });
      if (members.length !== reservationIds.length) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Some of these reservations are not in this group' });
      }

      let masterFolioId: string | null = null;
      if (dto.masterBill) {
        const lead = await tx.reservation.findFirst({ where: { id: dto.masterBill.leadReservationId, groupBlockId: blockId, deletedAt: null } });
        if (!lead) throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: "The lead guest's stay is not in this group" });
        const master = await this.foliosService.createAdditionalFolioInTx(
          tx,
          tenantId,
          lead.id,
          { label: `Group — ${block.name}`.slice(0, 100), payerName: block.contactName ?? undefined },
          actorId,
        );
        masterFolioId = master.id;
        await tx.reservation.updateMany({ where: { id: { in: reservationIds } }, data: { billToFolioId: master.id } });
      }

      const checkedIn: Array<{ reservationId: string; confirmationNumber: string; guestName: string; roomNumber: string | null }> = [];
      for (const assignment of dto.assignments) {
        const stay = await this.checkInInTx(tx, tenantId, assignment.reservationId, { roomId: assignment.roomId }, actorId);
        checkedIn.push({ reservationId: stay.id, confirmationNumber: stay.confirmationNumber, guestName: stay.guest.name, roomNumber: stay.room?.number ?? null });
      }

      await tx.auditLog.create({
        data: {
          tenantId,
          branchId: block.branchId,
          userId: actorId,
          action: 'group_block.checked_in',
          entityType: 'group_block',
          entityId: blockId,
          after: { reservationIds, count: checkedIn.length, ...(masterFolioId ? { masterFolioId } : {}) },
        },
      });
      return { checkedIn, masterFolioId };
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
      // this traceable back to the stay that caused it. Its waiting
      // stay-over service is replaced by this clean, not left beside it.
      await this.housekeepingService.supersedeStayoverTasksInTx(tx, tenantId, reservation.branchId, reservation.roomId, 'Guest checked out — the check-out clean replaces this', actorId);
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
      // The stay's points, once every night is on the bill — and in this
      // transaction, so a check-out that fails earns nothing.
      await this.loyaltyService.earnForStayInTx(tx, updated, actorId);

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

  // -------------------------------------------------------------------------
  // Cancellation — policy-enforced (ref: "Cancel with policy enforcement +
  // optional manager penalty waive", pms-mvp-timeline.html)
  // -------------------------------------------------------------------------

  /** Staff view of what cancelling would cost right now — the reference's Cancellation Policy summary and Penalty / Refund figures. */
  async getCancellationQuote(tenantId: string, reservationId: string): Promise<CancellationQuote> {
    return this.prisma.withTenant(tenantId, (tx) => this.quoteCancellationInTx(tx, reservationId, new Date()));
  }

  async cancel(tenantId: string, reservationId: string, dto: CancelReservationDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const { reservation } = await this.cancelInTx(tx, tenantId, reservationId, {
        actorId,
        source: 'staff',
        reason: dto.reason,
        acknowledgedPenaltyTotal: dto.acknowledgedPenaltyTotal,
        now: new Date(),
      });
      return reservation;
    });
  }

  /**
   * The reference's Manager Override: "bypasses the cancellation penalty —
   * for goodwill gestures or error corrections. The override is logged with
   * the manager's ID and a required reason." Owner/Manager only, enforced by
   * the controller's `@Roles` — a separate route rather than a flag on
   * `cancel`, so front desk can't reach the waiver by adding a field to the
   * request body.
   */
  async cancelWithWaiver(tenantId: string, reservationId: string, dto: CancelWithWaiverDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const { reservation } = await this.cancelInTx(tx, tenantId, reservationId, {
        actorId,
        source: 'staff',
        reason: dto.reason,
        waiverReason: dto.waiverReason,
        acknowledgedPenaltyTotal: dto.acknowledgedPenaltyTotal,
        now: new Date(),
      });
      return reservation;
    });
  }

  /** Shared with the public booking engine's guest quote, which runs inside its own tenant transaction. */
  async quoteCancellationInTx(tx: TenantTx, reservationId: string, now: Date): Promise<CancellationQuote> {
    const reservation = await this.findReservationOrThrow(tx, reservationId);
    const branch = await this.propertyService.assertBranch(tx, reservation.branchId);
    return this.buildCancellationQuote(tx, reservation, branch, now);
  }

  /**
   * THE cancellation path. Staff cancelling (with or without a manager's
   * waiver) and a guest cancelling from "Manage your booking" all come
   * through here, so the branch's policy is applied identically however a
   * booking is cancelled — the guest path only adds its own gates in front
   * (online cancellation allowed, not yet past check-in time).
   *
   * A charge, when there is one, is an ordinary `penalty` line on the
   * primary folio through `postAdHocCharge` — the primitive no-show
   * penalties use — so tax follows the branch's own rules and an unpaid
   * charge shows up as a City Ledger receivable like any other.
   *
   * No room release: `roomId` is always NULL before check-in (§2.7 of the
   * plan), and a cancelled reservation drops out of `HOLDING_STATUSES` the
   * moment its status changes.
   */
  async cancelInTx(
    tx: TenantTx,
    tenantId: string,
    reservationId: string,
    opts: {
      /** `null` when a guest cancels their own booking — the convention a public booking's `createdBy` already uses. */
      actorId: string | null;
      source: 'staff' | 'guest';
      reason?: string;
      /** Only the manager-override route sets this. */
      waiverReason?: string;
      /** The charge (tax included) the person cancelling was shown. A mismatch refuses the cancel. */
      acknowledgedPenaltyTotal?: string;
      now: Date;
    },
  ) {
    const reservation = await this.findReservationOrThrow(tx, reservationId);
    if (!CANCELLABLE_STATUSES.has(reservation.status)) {
      throw new ConflictException({
        code: ErrorCode.INVALID_STATUS_TRANSITION,
        message: `Cannot cancel a reservation with status "${reservation.status}"`,
      });
    }
    const branch = await this.propertyService.assertBranch(tx, reservation.branchId);
    const quote = await this.buildCancellationQuote(tx, reservation, branch, opts.now);

    // What was shown must be what's charged. The free window can close
    // between reading the quote and confirming; cancelling anyway would
    // charge an amount nobody saw.
    if (opts.acknowledgedPenaltyTotal !== undefined && !new Prisma.Decimal(opts.acknowledgedPenaltyTotal).equals(quote.penaltyTotal)) {
      throw new ConflictException({
        code: ErrorCode.CANCELLATION_TERMS_CHANGED,
        message: `The cancellation charge is now ${quote.currency} ${quote.penaltyTotal} — please review it before cancelling`,
      });
    }

    const updated = await tx.reservation.update({
      where: { id: reservationId },
      data: { status: 'cancelled' },
      include: RESERVATION_INCLUDE,
    });

    const penaltyAmount = new Prisma.Decimal(quote.penaltyAmount);
    const waived = Boolean(opts.waiverReason) && !penaltyAmount.isZero();
    let charged = new Prisma.Decimal(0);
    if (!penaltyAmount.isZero() && !waived) {
      const folio = await this.foliosService.ensurePrimaryFolio(tx, updated, opts.actorId);
      await this.foliosService.postAdHocCharge(
        tx,
        updated,
        folio,
        'penalty',
        penaltyAmount,
        `Cancellation Charge (${PENALTY_LABELS[quote.penaltyType]})`,
        opts.actorId,
      );
      await this.foliosService.settleIfFullyPaid(tx, folio, opts.actorId, 'cancellation');
      charged = new Prisma.Decimal(quote.penaltyTotal);
    }

    await this.audit(tx, tenantId, reservation.branchId, opts.actorId, 'reservation.cancelled', reservationId, {
      reason: opts.reason ?? null,
      source: opts.source,
      freeCancellationUntil: quote.freeCancellationUntil.toISOString(),
      withinFreeWindow: quote.withinFreeWindow,
      penaltyType: quote.penaltyType,
      penaltyTotal: quote.penaltyTotal,
      charged: charged.toFixed(2),
      waived,
      waiverReason: waived ? (opts.waiverReason ?? null) : null,
    });
    await this.commsLogService.logAutomatedInTx(tx, tenantId, reservation.branchId, {
      reservationId,
      guestId: updated.guestId,
      channel: 'email',
      subject: `Reservation Cancelled — ${updated.confirmationNumber}`,
      body: `Your reservation ${updated.confirmationNumber} has been cancelled.${opts.reason ? ` Reason: ${opts.reason}` : ''}${
        charged.isZero()
          ? ' No cancellation charge applies.'
          : ` A cancellation charge of ${quote.currency} ${charged.toFixed(2)} applies under the property's cancellation policy.`
      }`,
      trigger: 'cancellation',
    });
    return { reservation: updated, quote, charged };
  }

  private async buildCancellationQuote(tx: TenantTx, reservation: Reservation, branch: Branch, now: Date): Promise<CancellationQuote> {
    // The terms the booking was made under, not whatever the branch offers today.
    const policy = resolveCancellationPolicy(reservation.cancellationPolicy ?? branch.cancellationPolicy);
    const terms = cancellationTermsFor(reservation, branch, policy, now);
    const penalty = await this.foliosService.previewCharge(tx, reservation.branchId, 'penalty', terms.penaltyAmount);
    const penaltyTotal = penalty.total;
    const paidSoFar = await this.foliosService.paidOnPrimaryFolio(tx, reservation.id);
    const net = paidSoFar.minus(penaltyTotal);
    return {
      reservationId: reservation.id,
      status: reservation.status,
      cancellable: CANCELLABLE_STATUSES.has(reservation.status),
      currency: branch.currency,
      policy: { ...policy, summary: describeCancellationPolicy(policy, timeOfDay(branch.checkInTime).slice(0, 5), branch.currency) },
      checkInAt: terms.checkInAt,
      freeCancellationUntil: terms.freeUntil,
      withinFreeWindow: terms.withinFreeWindow,
      pastCheckInTime: terms.pastCheckInTime,
      penaltyType: terms.penaltyType,
      penaltyAmount: terms.penaltyAmount.toFixed(2),
      penaltyTax: penalty.addedTax.toFixed(2),
      penaltyTaxIncluded: penalty.includedTax.toFixed(2),
      penaltyTotal: penaltyTotal.toFixed(2),
      paidSoFar: paidSoFar.toFixed(2),
      refundDue: (net.greaterThan(0) ? net : new Prisma.Decimal(0)).toFixed(2),
      amountOwed: (net.lessThan(0) ? net.negated() : new Prisma.Decimal(0)).toFixed(2),
    };
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
      const policy = (branch.noShowPolicy ?? {}) as { defaultPenalty?: PenaltyType; flatFeeAmount?: number; cutoffTime?: string };
      // A guest can't have failed to arrive before they could have: never
      // before the arrival day, and on it only once the branch's no-show
      // cut-off has passed. The night audit applies the same rule on its own;
      // this is the button, which used to accept a booking a month away.
      const today = toBranchDate(todayInTimezone(branch.timezone));
      if (reservation.checkInDate > today) {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `This guest is due on ${reservation.checkInDate.toISOString().slice(0, 10)} — a booking can't be marked a no-show before its arrival day`,
        });
      }
      const cutoff = /^\d{2}:\d{2}$/.test(policy.cutoffTime ?? '') ? `${policy.cutoffTime}:00` : null;
      if (cutoff && reservation.checkInDate.getTime() === today.getTime() && !hasPassedBranchCutoff(today, cutoff, branch.timezone)) {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `Not yet — this branch marks no-shows after ${policy.cutoffTime} on the arrival day`,
        });
      }
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

    const penaltyAmount = penaltyAmountFor(reservation, penaltyType, flatFeeAmount);

    // `markedBy` straight through — NULL for the scheduled sweep, which is
    // what `postedBy`/`userId` mean by NULL ("system"). This used to fall back
    // to `''` and `'system'`, which Postgres rejects in those UUID columns;
    // the error aborted the whole night-audit transaction.
    const folio = await this.foliosService.ensurePrimaryFolio(tx, updated, markedBy);
    const penaltyLine =
      penaltyAmount && !penaltyAmount.isZero()
        ? await this.foliosService.postAdHocCharge(tx, updated, folio, 'penalty', penaltyAmount, `${NO_SHOW_PENALTY_LABEL} (${penaltyType.replace('_', ' ')})`, markedBy)
        : null;
    // The record keeps hold of the charge it posted, so a waiver reverses that
    // exact line and the tax posted with it.
    const noShowRecord = await tx.noShowRecord.create({
      data: { tenantId, reservationId: reservation.id, penaltyType, penaltyAmount, markedBy, penaltyLineItemId: penaltyLine?.id ?? null },
    });
    await this.foliosService.settleIfFullyPaid(tx, folio, markedBy, 'noShow');

    await this.audit(tx, tenantId, reservation.branchId, markedBy, 'reservation.no_show', reservation.id, {
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
      // Reverse the penalty line itself, with exactly the tax that went on
      // with it. This used to post a fresh negative charge through the tax
      // rules instead, which left a penalty's tax standing whenever the rule
      // was limited to penalties (a correction isn't a penalty).
      const penaltyLineId = record.penaltyLineItemId ?? (await this.findUnreversedNoShowPenalty(tx, folio.id));
      if (penaltyLineId) await this.foliosService.reverseChargeInTx(tx, tenantId, penaltyLineId, 'penalty waived', actorId);
      await this.foliosService.settleIfFullyPaid(tx, folio, actorId, 'noShowWaived');
    }

    await this.audit(tx, tenantId, reservation.branchId, actorId, 'no_show.penalty_waived', record.id, {
      penaltyAmount: record.penaltyAmount?.toFixed(2) ?? null,
    });
    return updated;
  }

  /** For a no-show marked before records linked their penalty line: the latest penalty line on the bill that nobody has reversed yet. */
  private async findUnreversedNoShowPenalty(tx: TenantTx, folioId: string): Promise<string | null> {
    const line = await tx.lineItem.findFirst({
      where: { folioId, chargeType: 'penalty', description: { startsWith: NO_SHOW_PENALTY_LABEL }, isVoid: false, deletedAt: null, correctedBy: null },
      orderBy: { postedAt: 'desc' },
      select: { id: true },
    });
    return line?.id ?? null;
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
      if (reservation.groupBlockId) await this.assertStaysInGroupBlock(tx, reservation.groupBlockId, reservation.roomTypeId, checkInDate, checkOutDate);
      await this.restrictionsService.assertNoViolation(tx, reservation.branchId, reservation.roomTypeId, checkInDate, checkOutDate);
      await this.lockRoomType(tx, reservation.roomTypeId);
      await this.assertAvailableForStay(tx, reservation.branchId, reservation.roomTypeId, checkInDate, checkOutDate, reservationId, reservation.groupBlockId ?? undefined);

      const resolved = await this.rateResolverService.resolveStay(
        tx,
        tenantId,
        reservation.branchId,
        roomType,
        checkInDate,
        checkOutDate,
        this.storedDeal(reservation),
        { triggeredBy: 'modify', userId: actorId, reservationId },
      );
      const pricing = await this.repricedStay(tx, reservation, resolved, checkInDate, checkOutDate);

      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'confirmed', checkInDate, checkOutDate, ratePlanId: resolved.ratePlanId, confirmedRate: pricing.subtotal, nightlyRates: pricing.nightlyRates },
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
      this.assertWithinCapacity(roomType, dto.adults ?? reservation.adults, dto.children ?? reservation.children);
      if (reservation.groupBlockId) await this.assertStaysInGroupBlock(tx, reservation.groupBlockId, roomTypeId, checkInDate, checkOutDate);

      const datesOrRoomTypeChanged =
        checkInDate.getTime() !== reservation.checkInDate.getTime() ||
        checkOutDate.getTime() !== reservation.checkOutDate.getTime() ||
        roomTypeId !== reservation.roomTypeId;
      // A waitlisted reservation holds no inventory (not in HOLDING_STATUSES),
      // so it never needs to pass this check against itself — but a
      // confirmed one is checked EXCLUDING its own current hold, so
      // shrinking a stay or nudging it by a day doesn't get rejected for
      // "conflicting" with the booking being changed.
      if (datesOrRoomTypeChanged) {
        // The same stop-sell and length-of-stay rules a new booking meets.
        await this.restrictionsService.assertNoViolation(tx, reservation.branchId, roomTypeId, checkInDate, checkOutDate);
      }
      if (datesOrRoomTypeChanged && reservation.status === 'confirmed') {
        await this.lockRoomType(tx, roomTypeId);
        await this.assertAvailableForStay(tx, reservation.branchId, roomTypeId, checkInDate, checkOutDate, reservationId, reservation.groupBlockId ?? undefined);
      }

      // Re-prices under the deal the stay was booked with — its company
      // account and promo code, kept on the reservation. (Until they were
      // stored, a modified company or promo booking silently fell back to
      // the public rate.) A promo whose dates no longer cover the new stay
      // simply doesn't apply: the Rate Resolver checks its window like any
      // booking's.
      const resolved = await this.rateResolverService.resolveStay(
        tx,
        tenantId,
        reservation.branchId,
        roomType,
        checkInDate,
        checkOutDate,
        this.storedDeal(reservation),
        { triggeredBy: 'modify', userId: actorId, reservationId },
      );
      const pricing = await this.repricedStay(tx, reservation, resolved, checkInDate, checkOutDate);

      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: {
          checkInDate,
          checkOutDate,
          roomTypeId,
          ratePlanId: resolved.ratePlanId,
          confirmedRate: pricing.subtotal,
          nightlyRates: pricing.nightlyRates,
          adults: dto.adults ?? reservation.adults,
          children: dto.children ?? reservation.children,
        },
        include: RESERVATION_INCLUDE,
      });

      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.modified', reservationId, {
        reason: dto.reason,
        before: { checkInDate: reservation.checkInDate, checkOutDate: reservation.checkOutDate, roomTypeId: reservation.roomTypeId, confirmedRate: reservation.confirmedRate.toFixed(2) },
        after: { checkInDate, checkOutDate, roomTypeId, confirmedRate: pricing.subtotal.toFixed(2) },
      });
      return updated;
    });
  }

  /**
   * `modifyReservation` deliberately rejects `checked_in` reservations —
   * "needs folio reconciliation, out of scope here" (its own comment).
   * This is the narrower operation that reconciliation actually requires:
   * a checked-in guest wanting more nights in the SAME room, not a general
   * date/room-type/party-size change mid-stay. Real edge case this closes,
   * matching a confirmed production bug class the in-house PMS's own
   * incident history named (`docs/LESSONS-LEARNED.md`): extending a stay
   * without recomputing the stay-total rate leaves guests undercharged —
   * `total_rate ÷ nights` (Roomick's own `confirmedRate ÷ nights`,
   * `postRoomChargeForDate`'s own derivation) silently drops once `nights`
   * grows but the numerator doesn't. Re-resolving through the Rate
   * Resolver for the FULL new date range and writing the new
   * `confirmedRate` back is what keeps that division honest for every
   * night posted from here on — nights already posted (real `LineItem`
   * rows) are never touched, matching the append-only ledger everywhere
   * else in this module.
   */
  async extendStay(tenantId: string, reservationId: string, dto: ExtendStayDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.findReservationOrThrow(tx, reservationId);
      if (reservation.status !== 'checked_in') {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `Cannot extend a reservation with status "${reservation.status}" — only a checked-in stay can be extended`,
        });
      }
      if (!reservation.roomId) {
        // Can't happen in practice (check-in always assigns a room before
        // flipping to checked_in) — guarded anyway since the type is nullable.
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'This reservation has no room assigned' });
      }

      const newCheckOutDate = toBranchDate(dto.checkOutDate);
      if (newCheckOutDate <= reservation.checkOutDate) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: 'The new check-out date must be after the current check-out date — this extends a stay, it does not shorten one',
        });
      }

      // Room-TYPE pool check, scoped to just the extension nights (old
      // checkout → new checkout) and excluding this reservation's own
      // existing hold — the same "re-check EXCLUDING its own current hold"
      // shape `modifyReservation` already uses. A checked-in guest keeps
      // their own physical room in practice; this proves the type's pool
      // isn't already fully committed to other guests for those nights.
      await this.restrictionsService.assertExtensionAllowed(tx, reservation.branchId, reservation.roomTypeId, reservation.checkInDate, reservation.checkOutDate, newCheckOutDate);
      await this.lockRoomType(tx, reservation.roomTypeId);
      await this.assertAvailableForStay(tx, reservation.branchId, reservation.roomTypeId, reservation.checkOutDate, newCheckOutDate, reservationId, reservation.groupBlockId ?? undefined);

      // The SPECIFIC assigned room must also be free of any block for the
      // extension nights — the pool check above can't see this; it counts
      // rooms, not which one this particular guest is standing in.
      const overlappingBlock = await tx.roomBlock.findFirst({
        where: { roomId: reservation.roomId, fromDate: { lt: newCheckOutDate }, toDate: { gte: reservation.checkOutDate } },
      });
      if (overlappingBlock) {
        throw new ConflictException({ code: ErrorCode.RESERVATION_NOT_AVAILABLE, message: 'This room is blocked for part of the extension' });
      }

      const roomType = await this.assertRoomType(tx, reservation.branchId, reservation.roomTypeId);
      const resolved = await this.rateResolverService.resolveStay(
        tx,
        tenantId,
        reservation.branchId,
        roomType,
        reservation.checkInDate,
        newCheckOutDate,
        this.storedDeal(reservation),
        { triggeredBy: 'extend_stay', userId: actorId, reservationId },
      );
      // A pinned nightly rate (a manager's override, a room move) is what the
      // extra nights are billed at, so it's what the stay total grows by —
      // re-pricing the whole stay would state a total the bill never shows.
      // The night-by-night list says the same: billed nights as billed, the rest at the pinned rate.
      const pinned = reservation.overrideRate
        ? await this.pricedWithPinnedRate(tx, { ...reservation, checkOutDate: newCheckOutDate }, new Prisma.Decimal(reservation.overrideRate))
        : null;
      const confirmedRate = pinned ? pinned.confirmedRate : resolved.subtotal;

      const previousCheckOutDate = reservation.checkOutDate;
      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { checkOutDate: newCheckOutDate, confirmedRate, ratePlanId: resolved.ratePlanId, nightlyRates: pinned ? pinned.nightlyRates : nightlyRatesOf(resolved) },
        include: RESERVATION_INCLUDE,
      });

      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.extended', reservationId, {
        previousCheckOutDate,
        newCheckOutDate,
        confirmedRate: confirmedRate.toFixed(2),
      });
      await this.commsLogService.logAutomatedInTx(tx, tenantId, reservation.branchId, {
        reservationId,
        guestId: reservation.guestId,
        channel: 'email',
        subject: `Your stay has been extended — ${reservation.confirmationNumber}`,
        body: `Your check-out date is now ${newCheckOutDate.toISOString().slice(0, 10)}.`,
        trigger: 'stay_extended',
      });
      return updated;
    });
  }

  /**
   * What moving an in-house guest to a room of `roomTypeId` would cost, for
   * the nights not yet on the bill — tonight onwards. Two prices: the rate
   * they booked, and the new room type's own rate under the stay's deal
   * (its company, its promo code). Read-only: nothing is written, not even
   * the Rate Resolver's audit rows.
   */
  async roomMoveQuote(tenantId: string, reservationId: string, roomTypeId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.findReservationOrThrow(tx, reservationId);
      this.assertMovable(reservation);
      const roomType = await this.assertRoomType(tx, reservation.branchId, roomTypeId);
      const plan = await this.roomMovePlan(tx, tenantId, reservation, roomType, false);
      return {
        nightsLeft: plan.nightsLeft.length,
        firstNight: plan.nightsLeft[0]?.toISOString().slice(0, 10) ?? null,
        tonightAlreadyBilled: plan.tonightAlreadyBilled,
        currentNightly: plan.currentNightly.toFixed(2),
        keepTotal: plan.currentNightly.mul(plan.nightsLeft.length).toFixed(2),
        newNightly: plan.newNightly.toFixed(2),
        newTotal: plan.newTotal.toFixed(2),
      };
    });
  }

  /**
   * Room Move / Room Upgrade (ref: "Switch guest to higher room category")
   * — an in-house guest changes rooms: the AC failed, they asked for a
   * suite, a family needs two beds. Takes effect from tonight:
   *
   * - **Nights already on the bill stay as billed.** Any past night the
   *   night audit hasn't reached yet is billed first, at the old rate — the
   *   guest slept in the old room.
   * - **Keep the rate** (`chargeNewRate: false`): the guest pays what they
   *   booked. Moving to another type pins that nightly rate
   *   (`overrideRate`), so extending the stay later can't quietly re-price
   *   it at the new type.
   * - **Charge the new rate**: the nights left are priced at the new room
   *   type under the stay's own deal, and pinned at that nightly rate.
   *
   * The old room is vacated dirty with a housekeeping task, as at
   * check-out; the new one is occupied. A different room type must have a
   * room to spare for the nights left (the guest's own hold excluded).
   */
  async moveRoom(tenantId: string, reservationId: string, dto: { roomId: string; reason: string; chargeNewRate: boolean }, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.findReservationOrThrow(tx, reservationId);
      this.assertMovable(reservation);
      const fromRoomId = reservation.roomId as string;
      if (dto.roomId === fromRoomId) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'The guest is already in this room' });
      }
      const room = await tx.room.findFirst({ where: { id: dto.roomId, deletedAt: null } });
      if (!room || room.branchId !== reservation.branchId) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room not found' });
      }
      const branch = await this.propertyService.assertBranch(tx, reservation.branchId);
      const today = toBranchDate(todayInTimezone(branch.timezone));
      const tonight = today > reservation.checkInDate ? today : reservation.checkInDate;
      // Physically free for the nights left — the same hard checks as check-in.
      await this.lockRoom(tx, room.id);
      await this.assertRoomCheckInReady(tx, room, reservation.branchId, room.roomTypeId, tonight, reservation.checkOutDate > tonight ? reservation.checkOutDate : tonight);

      const typeChanges = room.roomTypeId !== reservation.roomTypeId;
      if (typeChanges && reservation.checkOutDate > tonight) {
        await this.lockRoomType(tx, room.roomTypeId);
        await this.assertAvailableForStay(tx, reservation.branchId, room.roomTypeId, tonight, reservation.checkOutDate, reservationId);
      }

      // The past at the old rate first, while the stay still carries it.
      const folio = await this.foliosService.ensurePrimaryFolio(tx, reservation, actorId);
      await this.foliosService.backfillRoomCharges(tx, reservation, folio, today, 'Room move', actorId);

      const newType = await this.assertRoomType(tx, reservation.branchId, room.roomTypeId);
      const plan = await this.roomMovePlan(tx, tenantId, reservation, newType, true, actorId);
      const nights = this.stayNights(reservation);
      const reason = dto.reason.trim();

      // The nightly rate pinned from tonight, when the move pins one.
      let nightly: Prisma.Decimal | null = null;
      let rate: Prisma.ReservationUncheckedUpdateInput = {};
      if (dto.chargeNewRate && plan.nightsLeft.length > 0) {
        nightly = plan.newTotal.div(plan.nightsLeft.length).toDecimalPlaces(2);
        rate = {
          overrideRate: nightly,
          overrideReason: `Room move to ${newType.name} — ${reason}`.slice(0, 500),
          confirmedRate: plan.currentNightly.mul(nights - plan.nightsLeft.length).plus(plan.newTotal),
        };
      } else if (typeChanges && !reservation.overrideRate) {
        nightly = plan.currentNightly;
        rate = { overrideRate: nightly, overrideReason: `Moved to ${newType.name} at the booked rate — ${reason}`.slice(0, 500) };
      }

      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { roomId: room.id, roomTypeId: room.roomTypeId, ...rate },
        include: RESERVATION_INCLUDE,
      });

      // The old room needs cleaning before anyone else sleeps in it — vacated dirty, on the Task Board, as at check-out.
      await this.roomsService.applyReservationOccupancy(tx, tenantId, fromRoomId, { occupancyStatus: 'vacant', cleanlinessStatus: 'dirty' }, actorId);
      await this.housekeepingService.supersedeStayoverTasksInTx(tx, tenantId, reservation.branchId, fromRoomId, `Guest moved to room ${room.number} — the move's clean replaces this`, actorId);
      await this.housekeepingService.createTaskInTx(tx, tenantId, reservation.branchId, {
        roomId: fromRoomId,
        triggerEvent: 'room_move',
        triggeredByReservationId: reservationId,
        notes: `Guest moved to room ${room.number}`,
        taskDate: today,
        actorId,
      });
      await this.roomsService.applyReservationOccupancy(tx, tenantId, room.id, { occupancyStatus: 'occupied' }, actorId);

      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.room_moved', reservationId, {
        fromRoomId,
        toRoomId: room.id,
        ...(typeChanges ? { fromRoomTypeId: reservation.roomTypeId, toRoomTypeId: room.roomTypeId } : {}),
        rate: dto.chargeNewRate && plan.nightsLeft.length > 0 ? 'new' : 'kept',
        nightsLeft: plan.nightsLeft.length,
        ...(nightly ? { nightlyRate: nightly.toFixed(2) } : {}),
        reason,
      });
      return updated;
    });
  }

  private assertMovable(reservation: Reservation): void {
    if (reservation.status !== 'checked_in' || !reservation.roomId) {
      throw new ConflictException({
        code: ErrorCode.INVALID_STATUS_TRANSITION,
        message: 'Only a guest who is checked in can change rooms — before arrival, change the room type with Modify Reservation',
      });
    }
  }

  /**
   * The nights a room move prices: from tonight to check-out, less any night
   * already on the bill (moving on arrival day, tonight was billed at
   * check-in). Priced two ways — the stay's current nightly rate, and the
   * new room type's rate under the stay's deal.
   */
  private async roomMovePlan(tx: TenantTx, tenantId: string, reservation: Reservation, newType: RoomType, persistAudit: boolean, actorId?: string) {
    const branch = await this.propertyService.assertBranch(tx, reservation.branchId);
    const today = toBranchDate(todayInTimezone(branch.timezone));
    const tonight = today > reservation.checkInDate ? today : reservation.checkInDate;
    const billed = await tx.lineItem.findMany({
      where: {
        chargeType: 'room',
        isVoid: false,
        deletedAt: null,
        OR: [{ stayReservationId: reservation.id }, { stayReservationId: null, folio: { reservationId: reservation.id } }],
      },
      select: { serviceDate: true },
    });
    const billedDates = new Set(billed.map((line) => line.serviceDate?.toISOString().slice(0, 10)));
    const nightsLeft: Date[] = [];
    for (let night = new Date(tonight); night < reservation.checkOutDate; night = new Date(night.getTime() + 86_400_000)) {
      if (!billedDates.has(night.toISOString().slice(0, 10))) nightsLeft.push(night);
    }

    const currentNightly = reservation.overrideRate
      ? new Prisma.Decimal(reservation.overrideRate)
      : new Prisma.Decimal(reservation.confirmedRate).div(this.stayNights(reservation)).toDecimalPlaces(2);

    let newTotal = new Prisma.Decimal(0);
    if (nightsLeft.length > 0) {
      const resolved = await this.rateResolverService.resolveStay(
        tx,
        tenantId,
        reservation.branchId,
        newType,
        nightsLeft[0],
        reservation.checkOutDate,
        this.storedDeal(reservation),
        { triggeredBy: 'room_move', userId: actorId, reservationId: reservation.id, persistAudit },
      );
      const left = new Set(nightsLeft.map((night) => night.toISOString().slice(0, 10)));
      newTotal = resolved.perNight.filter((n) => left.has(n.date)).reduce((sum, n) => sum.plus(n.finalRate), new Prisma.Decimal(0));
    }
    return {
      nightsLeft,
      tonightAlreadyBilled: billedDates.has(tonight.toISOString().slice(0, 10)) && tonight < reservation.checkOutDate,
      currentNightly,
      newNightly: nightsLeft.length > 0 ? newTotal.div(nightsLeft.length).toDecimalPlaces(2) : new Prisma.Decimal(0),
      newTotal,
    };
  }

  private stayNights(reservation: Reservation): number {
    return Math.max(1, Math.round((reservation.checkOutDate.getTime() - reservation.checkInDate.getTime()) / 86_400_000));
  }

  /**
   * Manager Dashboard's "Rate Override" — pins an absolute nightly rate,
   * independent of `confirmedRate` (the stay total the Rate Resolver
   * produced). Deliberately NOT restricted to pre-check-in: the whole point
   * is a manager stepping in on a live folio (a service-recovery gesture,
   * a VIP comp) just as much as a pre-arrival adjustment — `checked_in` is
   * allowed. Rejected only once nothing is left to charge for
   * (`checked_out`/`cancelled`/`no_show`/`walked`), and on `waitlisted`
   * (no confirmed stay yet to override).
   */
  async setRateOverride(tenantId: string, reservationId: string, dto: SetRateOverrideDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.findReservationOrThrow(tx, reservationId);
      if (reservation.status !== 'confirmed' && reservation.status !== 'checked_in') {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `Cannot override the rate on a reservation with status "${reservation.status}" — only a confirmed or checked-in stay has charges left to affect`,
        });
      }

      const previousOverrideRate = reservation.overrideRate ? reservation.overrideRate.toFixed(2) : null;
      // The stay's total follows the rate: nights already on the bill at
      // what they were posted at, every other night at the new one. It used
      // to keep the old total, so the registration card, "Manage your
      // booking" and a full-stay cancellation charge all priced the stay at
      // a rate the bill no longer used.
      const priced = await this.pricedWithPinnedRate(tx, reservation, new Prisma.Decimal(dto.overrideRate));
      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { overrideRate: dto.overrideRate, overrideReason: dto.reason, confirmedRate: priced.confirmedRate, nightlyRates: priced.nightlyRates },
        include: RESERVATION_INCLUDE,
      });

      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.rate_overridden', reservationId, {
        previousOverrideRate,
        overrideRate: dto.overrideRate.toFixed(2),
        previousConfirmedRate: reservation.confirmedRate.toFixed(2),
        confirmedRate: priced.confirmedRate.toFixed(2),
        reason: dto.reason,
      });
      return updated;
    });
  }

  /**
   * What a stay comes to once `nightly` is pinned for every night not yet on
   * the bill: a night already posted at what it was posted at (net of any
   * correction), every other night at the pinned rate. Returns the total and
   * the night-by-night list the bill will follow.
   */
  private async pricedWithPinnedRate(tx: TenantTx, reservation: Reservation, nightly: Prisma.Decimal): Promise<{ confirmedRate: Prisma.Decimal; nightlyRates: Prisma.InputJsonValue }> {
    const posted = await tx.lineItem.findMany({
      where: {
        chargeType: 'room',
        isVoid: false,
        deletedAt: null,
        OR: [{ stayReservationId: reservation.id }, { stayReservationId: null, folio: { reservationId: reservation.id } }],
      },
      select: { serviceDate: true, amount: true, correctedBy: { select: { amount: true, isVoid: true, deletedAt: true } } },
    });
    const postedByNight = new Map<string, Prisma.Decimal>();
    for (const line of posted) {
      if (!line.serviceDate) continue;
      const reversal = line.correctedBy && !line.correctedBy.isVoid && !line.correctedBy.deletedAt ? line.correctedBy.amount : new Prisma.Decimal(0);
      const night = line.serviceDate.toISOString().slice(0, 10);
      postedByNight.set(night, (postedByNight.get(night) ?? new Prisma.Decimal(0)).plus(line.amount).plus(reversal));
    }
    const nights: Array<{ date: string; rate: string }> = [];
    let total = new Prisma.Decimal(0);
    for (let night = new Date(reservation.checkInDate); night < reservation.checkOutDate; night = new Date(night.getTime() + 86_400_000)) {
      const date = night.toISOString().slice(0, 10);
      const rate = postedByNight.get(date) ?? nightly;
      nights.push({ date, rate: rate.toFixed(2) });
      total = total.plus(rate);
    }
    return { confirmedRate: total, nightlyRates: nights };
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
      await this.lockRoomType(tx, reservation.roomTypeId);
      await this.assertAvailableForStay(tx, reservation.branchId, reservation.roomTypeId, reservation.checkInDate, reservation.checkOutDate);
      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'confirmed' },
        include: RESERVATION_INCLUDE,
      });
      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.promoted', reservationId);

      // The guest hears that their waitlisted request is now a booking — the
      // same confirmation an ordinary booking sends, priced from what the
      // reservation already holds.
      const branch = await this.propertyService.assertBranch(tx, reservation.branchId);
      const priced = await this.taxesService.priceCharge(tx, reservation.branchId, 'room', updated.confirmedRate, this.stayNights(updated));
      await this.commsLogService.logAutomatedInTx(tx, tenantId, reservation.branchId, {
        reservationId,
        guestId: updated.guestId,
        channel: 'email',
        subject: `Reservation Confirmed — ${updated.confirmationNumber}`,
        body: bookingConfirmationBody({
          guestName: updated.guest.name,
          confirmationNumber: updated.confirmationNumber,
          branch,
          roomTypeName: updated.roomType.name,
          checkInDate: updated.checkInDate.toISOString().slice(0, 10),
          checkOutDate: updated.checkOutDate.toISOString().slice(0, 10),
          adults: updated.adults,
          children: updated.children,
          subtotal: priced.price,
          taxTotal: priced.addedTax,
          total: priced.total,
        }),
        trigger: 'booking_confirmation',
      });
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
  async walkReservation(tenantId: string, reservationId: string, dto: WalkReservationDto, actor: JwtPayload) {
    const actorId = actor.sub;
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

      // What the guest paid goes back through the refund workflow — approval,
      // and the cash-shift rule when it is handed over — not as reversal rows
      // written straight into the ledger, which skipped both. A manager's own
      // request is approved on the spot; the money leaves at pay-out.
      const folio = await tx.folio.findFirst({ where: { reservationId, deletedAt: null } });
      let refundRequested = new Prisma.Decimal(0);
      if (folio) {
        const { available } = await this.refundsService.refundable(tx, folio.id);
        if (available.greaterThan(0)) {
          const lastPayment = await tx.payment.findFirst({
            where: { folioId: folio.id, isVoid: false, deletedAt: null, amount: { gt: 0 }, method: { in: ['cash', 'card', 'bank_transfer'] } },
            orderBy: { recordedAt: 'desc' },
            select: { method: true },
          });
          await this.refundsService.requestInTx(
            tx,
            tenantId,
            folio,
            { amount: Number(available.toFixed(2)), method: (lastPayment?.method ?? 'bank_transfer') as 'cash' | 'card' | 'bank_transfer', reason: `Walked to ${dto.relocationProperty}` },
            actor,
          );
          refundRequested = available;
        }
      }

      await this.audit(tx, tenantId, reservation.branchId, actorId, 'reservation.walked', reservationId, {
        relocationProperty: dto.relocationProperty,
        refundRequested: refundRequested.toFixed(2),
      });
      return { reservation: updated, walkRecord, refundRequested: refundRequested.toFixed(2) };
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
  /** Newest first, a page at a time (`limit`/`offset`, 100 unless asked); `countReservations` says how many there are in all. */
  async listReservations(tenantId: string, branchId: string, dto: ListReservationsQueryDto) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      return tx.reservation.findMany({
        where: this.listWhere(branchId, dto),
        include: RESERVATION_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: dto.limit ?? 100,
        skip: dto.offset ?? 0,
      });
    });
  }

  /** How many `listReservations` would return in all — the list itself stops at its limit, silently before this existed. */
  async countReservations(tenantId: string, branchId: string, dto: ListReservationsQueryDto): Promise<{ count: number }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      return { count: await tx.reservation.count({ where: this.listWhere(branchId, dto) }) };
    });
  }

  private listWhere(branchId: string, dto: ListReservationsQueryDto): Prisma.ReservationWhereInput {
    const search = dto.search?.trim();
    return {
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
    };
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

  /**
   * `RoomType.capacity` (`{adults, children}`, set once at room-type
   * creation) was never actually checked against anywhere — a booking for
   * 4 adults and 9 children against a 2-adult room type went through with
   * no cap and no warning. Adults/children are checked independently, not
   * combined into one total, matching the field's own two-number shape.
   */
  private assertWithinCapacity(roomType: RoomType, adults: number, children: number): void {
    const capacity = roomType.capacity as { adults: number; children: number };
    if (adults > capacity.adults || children > capacity.children) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: `${roomType.name} sleeps up to ${capacity.adults} adult(s) and ${capacity.children} child(ren) — ${adults} adult(s) and ${children} child(ren) exceeds capacity`,
      });
    }
  }

  private async assertAvailableForStay(
    tx: TenantTx,
    branchId: string,
    roomTypeId: string,
    checkInDate: Date,
    checkOutDate: Date,
    excludeReservationId?: string,
    bookingIntoBlockId?: string,
  ): Promise<void> {
    const perNight = await this.computeAvailabilityPerNight(tx, branchId, roomTypeId, checkInDate, checkOutDate, excludeReservationId, bookingIntoBlockId);
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
   * `RES-<year>-<n>`, where `n` comes from the organisation's own counter
   * (`Tenant.reservationSeq`), bumped atomically — one sequence for every
   * branch, because the number is unique per tenant (`@@unique([tenantId,
   * confirmationNumber])`). It used to count THIS branch's reservations and
   * try the next five numbers: the moment one branch had five bookings, a
   * second branch's first booking found all five taken and failed. The
   * `tenants` table sits outside row-level security, so the counter is
   * reachable from inside the tenant transaction.
   */
  private async generateConfirmationNumber(tx: TenantTx, tenantId: string): Promise<string> {
    const [row] = await tx.$queryRaw<Array<{ reservationSeq: number }>>`
      UPDATE tenants SET "reservationSeq" = "reservationSeq" + 1 WHERE id = ${tenantId}::uuid RETURNING "reservationSeq"`;
    if (!row) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Organisation not found' });
    return `RES-${new Date().getFullYear()}-${String(row.reservationSeq).padStart(5, '0')}`;
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
  /**
   * The deal a booking is made under: its promo code, and the company it's
   * booked for. A company has to be an active account of this tenant — a
   * stale or made-up id would otherwise price at the public rate while the
   * booking still claimed the company.
   */
  private async dealTerms(tx: TenantTx, dto: { promoCode?: string; corporateAccountId?: string }): Promise<{ promoCode?: string; corporateAccountId?: string }> {
    const promoCode = dto.promoCode?.trim() || undefined;
    if (!dto.corporateAccountId) return { promoCode };
    const account = await tx.corporateAccount.findFirst({ where: { id: dto.corporateAccountId, isActive: true }, select: { id: true } });
    if (!account) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'That company account is not active — pick another, or book without one' });
    }
    return { promoCode, corporateAccountId: account.id };
  }

  /** The deal a stay was booked under, for re-pricing it: a modified or extended stay keeps its company rate and promo code. */
  private storedDeal(reservation: { promoCode: string | null; corporateAccountId: string | null }): { promoCode?: string; corporateAccountId?: string } {
    return { promoCode: reservation.promoCode ?? undefined, corporateAccountId: reservation.corporateAccountId ?? undefined };
  }

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
        data.confirmationNumber = await this.generateConfirmationNumber(tx, data.tenantId);
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

  /**
   * Every change to a booking is recorded here, so this is also where the
   * change becomes a webhook event (`RESERVATION_ACTION_EVENTS`) — in the same
   * transaction, so nothing that changes a booking can skip telling anyone.
   */
  private async audit(
    tx: TenantTx,
    tenantId: string,
    branchId: string,
    userId: string | null,
    action: string,
    entityId: string,
    after?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: { tenantId, branchId, userId, action, entityType: 'reservation', entityId, after },
    });
    const previousRoomId = action === 'reservation.room_moved' ? (after as { fromRoomId?: string } | undefined)?.fromRoomId : undefined;
    await this.webhookEvents.reservationChanged(tx, { tenantId, branchId, action, reservationId: entityId, previousRoomId });
  }
}
