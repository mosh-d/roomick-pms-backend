import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommunicationLog, Reservation } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CommsLogService } from '../comms-log/comms-log.service';
import { FoliosService } from '../folios/folios.service';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { RateResolverService } from '../rate-resolver/rate-resolver.service';
import { ReservationsService } from '../reservations/reservations.service';
import {
  CANCELLABLE_STATUSES,
  CancellationQuote,
  cancellationTermsFor,
  describeCancellationPolicy,
  resolveCancellationPolicy,
} from '../reservations/policies';
import {
  CancelBookingDto,
  GuestMessageDto,
  LookupBookingDto,
  PreArrivalCheckInDto,
  PublicAvailabilityQueryDto,
  PublicCreateReservationDto,
  PublicQuoteQueryDto,
  PublishBookingEngineDto,
} from './dto/public-booking.dto';

/** A tenant in one of these states has stopped paying for / closed its account — its properties stop accepting public bookings. */
const BOOKABLE_TENANT_STATUSES = new Set(['trial', 'active']);

/** Only a stay that hasn't started yet can be pre-checked-in. `waitlisted` is excluded too — there's no confirmed stay to prepare for. */
const PRE_ARRIVAL_ELIGIBLE_STATUSES = new Set(['confirmed']);

/**
 * Stays where there's a bill to show. A folio is only created at check-in, so
 * a `confirmed` stay has nothing yet. No-show penalties and walked stays are
 * deliberately out of this slice — a disputed penalty is a conversation, not
 * something to surface on an anonymous page first.
 */
const FOLIO_VISIBLE_STATUSES = new Set(['checked_in', 'checked_out']);

interface ResolvedBookableBranch {
  tenantId: string;
  branchId: string;
}

export interface PublicPropertyInfo {
  slug: string;
  name: string;
  category: string | null;
  currency: string;
  timezone: string;
  checkInTime: string;
  checkOutTime: string;
  address: unknown;
  brandName: string;
  /** Guest-facing by nature — a guest has to be able to read the terms before booking. */
  cancellationPolicy: { summary: string; freeCancellationHours: number; allowOnlineCancellation: boolean };
}

export interface PublicQuote {
  currency: string;
  nightlyRate: string;
  subtotal: string;
  taxTotal: string;
  totalWithTax: string;
  nights: number;
  /** The cancellation terms this stay would book under — including when it starts so soon that the free window has already closed. */
  cancellation: { summary: string; freeCancellationUntil: Date; freeCancellationAvailable: boolean };
}

export interface PublicRoomType {
  id: string;
  name: string;
  bedType: string | null;
  sizeM2: string | null;
  amenities: string[];
  photoUrls: string[];
  baseRate: string;
  maxAdults: number;
  maxChildren: number;
}

/** What a guest may see about their own booking. Deliberately no ids, no folio internals, no staff-only fields. */
export interface PublicBookingDetail {
  confirmationNumber: string;
  status: string;
  checkInDate: Date;
  checkOutDate: Date;
  adults: number;
  children: number;
  specialRequests: string | null;
  roomTypeName: string;
  guestName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  guestNationality: string | null;
  totalRate: string;
  currency: string;
  preArrivalCompletedAt: Date | null;
  estimatedArrivalTime: string | null;
  houseRules: string | null;
  /** The cancellation terms this booking was made under, as one sentence. */
  cancellationPolicySummary: string;
  property: PublicPropertyInfo;
}

/** A charge as a guest sees it — no staff ids, outlet, tax-rule ids, or the parent's denormalised `taxAmount` (tax appears as its own lines). */
export interface PublicFolioLine {
  description: string;
  chargeType: string;
  amount: string;
  serviceDate: Date | null;
  postedAt: Date;
}

/** A payment as a guest sees it — no card/bank reference, shift, or staff ids. */
export interface PublicFolioPayment {
  method: string;
  purpose: string;
  amount: string;
  recordedAt: Date;
}

export interface PublicGuestFolio {
  confirmationNumber: string;
  currency: string;
  lineItems: PublicFolioLine[];
  payments: PublicFolioPayment[];
  subTotal: string;
  taxTotal: string;
  totalCost: string;
  paymentsTotal: string;
  balanceDue: string;
  /** True mid-stay: room nights are posted one at a time, so the charges shown are only those posted so far. */
  stillAccruing: boolean;
  /** The agreed room rate for the whole stay, shown alongside a still-accruing bill so a guest isn't misled into reading one night's charge as their total. */
  roomTotalForStay: string | null;
  /** Other folios on this stay (split billing, e.g. to a company) — their contents are never shown here, only that they exist. */
  otherFoliosExist: boolean;
  asOf: Date;
}

export interface PublicBookingConfirmation {
  confirmationNumber: string;
  checkInDate: Date;
  checkOutDate: Date;
  roomTypeName: string;
  guestName: string;
  totalRate: string;
  currency: string;
}

/** What a guest sees before cancelling: the terms and the charge — no ids, no folio internals. */
export interface PublicCancellationQuote {
  confirmationNumber: string;
  currency: string;
  /** False when the guest can't cancel online — the property has turned it off, or it's past check-in time on the arrival day. `blockedReason` says which. */
  canCancelOnline: boolean;
  blockedReason: string | null;
  policySummary: string;
  freeCancellationUntil: Date;
  withinFreeWindow: boolean;
  charge: { amount: string; tax: string; total: string };
  paidSoFar: string;
  refundDue: string;
}

export interface PublicCancellationResult {
  booking: PublicBookingDetail;
  /** What was actually charged, tax included — `0.00` for a free cancellation. */
  charged: string;
  currency: string;
}

/** One message as a guest sees it — who it's from and what it says; no staff ids, channels or delivery internals. */
export interface PublicMessage {
  from: 'you' | 'property';
  body: string;
  /** "Late check-out request" etc. for a request the guest tagged; null otherwise. */
  requestLabel: string | null;
  sentAt: Date;
}

export interface PublicMessageThread {
  confirmationNumber: string;
  propertyName: string;
  messages: PublicMessage[];
}

export interface PublicMessageSent extends PublicMessageThread {
  /** True when a checked-in guest's housekeeping request went straight onto the housekeeping task board. */
  housekeepingTaskCreated: boolean;
}

function toPublicMessage(row: CommunicationLog): PublicMessage {
  return {
    from: row.direction === 'inbound' ? 'you' : 'property',
    body: row.body,
    requestLabel: row.direction === 'inbound' ? row.subject : null,
    sentAt: row.sentAt,
  };
}

/**
 * The Direct Booking Engine's public, unauthenticated surface (Month 7).
 *
 * Every method starts by resolving a public slug to a real, currently
 * bookable branch, and everything after that runs inside the ordinary
 * `withTenant` RLS transaction every authenticated module already uses —
 * there is no second, weaker data path here.
 *
 * Nothing in this service re-implements pricing or availability. A quote
 * calls the same `RateResolverService` a front-desk agent's screen calls, and
 * a booking calls the same `ReservationsService.createReservation` a
 * front-desk agent's booking goes through — which means a direct booking and
 * a staff booking for the same room and dates resolve to the same rate
 * structurally, not by convention.
 */
@Injectable()
export class PublicBookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationsService: ReservationsService,
    private readonly rateResolverService: RateResolverService,
    private readonly foliosService: FoliosService,
    private readonly commsLogService: CommsLogService,
    private readonly housekeepingService: HousekeepingService,
  ) {}

  // ---------------------------------------------------------------------------
  // Slug resolution — the one place a request crosses into a tenant
  // ---------------------------------------------------------------------------

  /**
   * `booking_slug_index` is deliberately not RLS-scoped (see its schema
   * comment) because `branches` is — an unauthenticated request has no
   * `app.tenant_id` to set, so it would read zero rows from `branches`
   * itself. The index is only a POINTER though: the real branch is always
   * re-loaded and re-authorized inside `withTenant` below, so a stale or
   * tampered index row still can't expose an unpublished property.
   *
   * Every failure mode returns the same generic 404. A booking URL that
   * exists-but-is-unpublished must not be distinguishable from one that was
   * never real, or the endpoint becomes a property-enumeration oracle.
   */
  private async resolveBookableBranch(slug: string): Promise<ResolvedBookableBranch> {
    const pointer = await this.prisma.bookingSlugIndex.findUnique({ where: { slug } });
    if (!pointer) throw this.notFound();

    const branch = await this.prisma.withTenant(pointer.tenantId, (tx) =>
      tx.branch.findFirst({
        where: { id: pointer.branchId, bookingEngineEnabled: true, deletedAt: null },
        select: { id: true },
      }),
    );
    if (!branch) throw this.notFound();

    // Checked outside withTenant because `tenants` is the RLS root and has no
    // tenantId column of its own.
    const tenant = await this.prisma.tenant.findUnique({ where: { id: pointer.tenantId }, select: { status: true } });
    if (!tenant || !BOOKABLE_TENANT_STATUSES.has(tenant.status)) throw this.notFound();

    return { tenantId: pointer.tenantId, branchId: pointer.branchId };
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'No bookable property found at this address' });
  }

  /** One message for every way a booking lookup can fail. A wrong confirmation number and a wrong email must be indistinguishable, or sequential numbers become enumerable. */
  private bookingNotFound(): NotFoundException {
    return new NotFoundException({
      code: ErrorCode.NOT_FOUND,
      message: 'We could not find a booking with that confirmation number and email address',
    });
  }

  // ---------------------------------------------------------------------------
  // Public reads
  // ---------------------------------------------------------------------------

  /**
   * Public-safe property detail only. Explicitly NOT returned: tenant id,
   * branch id, internal policies, no-show policy, reg-card template,
   * overbooking configuration, staff, or anything financial.
   *
   * The cancellation policy IS returned — as the generated sentence and the
   * two facts a guest needs — because guests must be able to read the terms
   * before they book.
   */
  async getProperty(slug: string): Promise<PublicPropertyInfo> {
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await tx.branch.findFirstOrThrow({
        where: { id: branchId },
        select: {
          name: true,
          category: true,
          currency: true,
          timezone: true,
          checkInTime: true,
          checkOutTime: true,
          address: true,
          cancellationPolicy: true,
          brand: { select: { name: true } },
        },
      });
      // Stored as a Postgres TIME, surfaced by Prisma as a 1970-01-01
      // DateTime — only the time-of-day half is meaningful.
      const checkInTime = branch.checkInTime.toISOString().slice(11, 16);
      const cancellation = resolveCancellationPolicy(branch.cancellationPolicy);
      return {
        slug,
        name: branch.name,
        category: branch.category,
        currency: branch.currency,
        timezone: branch.timezone,
        checkInTime,
        checkOutTime: branch.checkOutTime.toISOString().slice(11, 16),
        address: branch.address,
        brandName: branch.brand.name,
        cancellationPolicy: {
          summary: describeCancellationPolicy(cancellation, checkInTime, branch.currency),
          freeCancellationHours: cancellation.freeCancellationHours,
          allowOnlineCancellation: cancellation.allowOnlineCancellation,
        },
      };
    });
  }

  async listRoomTypes(slug: string): Promise<PublicRoomType[]> {
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const roomTypes = await tx.roomType.findMany({
        where: { branchId, deletedAt: null },
        select: { id: true, name: true, bedType: true, sizeM2: true, amenities: true, photoUrls: true, baseRate: true, capacity: true, sortOrder: true },
        // The property's own chosen display order first (the same ordering
        // its internal room-type screens use), cheapest-first only as the
        // tiebreak when nothing has been ordered.
        orderBy: [{ sortOrder: 'asc' }, { baseRate: 'asc' }],
      });
      return roomTypes.map((rt) => {
        const capacity = (rt.capacity ?? {}) as { adults?: number; children?: number };
        return {
          id: rt.id,
          name: rt.name,
          bedType: rt.bedType,
          sizeM2: rt.sizeM2?.toString() ?? null,
          amenities: rt.amenities,
          photoUrls: rt.photoUrls,
          baseRate: rt.baseRate.toFixed(2),
          maxAdults: capacity.adults ?? 1,
          maxChildren: capacity.children ?? 0,
        };
      });
    });
  }

  /**
   * Reuses the same per-night computation the internal availability screens
   * use — never a separate, looser "is it probably free?" check. With a
   * `roomTypeId` it answers for that one type; without, for every bookable
   * type at the property, which is the shape a booking widget actually needs.
   */
  async getAvailability(slug: string, dto: PublicAvailabilityQueryDto): Promise<Array<{ roomTypeId: string; roomTypeName: string; nights: unknown }>> {
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);
    const from = toBranchDate(dto.from);
    const to = toBranchDate(dto.to);

    if (!dto.roomTypeId) {
      return this.reservationsService.getAvailabilityForRange(tenantId, branchId, from, to);
    }

    const nights = await this.reservationsService.getAvailability(tenantId, branchId, { from: dto.from, to: dto.to, roomTypeId: dto.roomTypeId });
    const roomType = await this.prisma.withTenant(tenantId, (tx) =>
      tx.roomType.findFirst({ where: { id: dto.roomTypeId, branchId, deletedAt: null }, select: { id: true, name: true } }),
    );
    if (!roomType) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found at this property' });
    return [{ roomTypeId: roomType.id, roomTypeName: roomType.name, nights }];
  }

  /**
   * A real Rate Resolver quote, through the exact cascade a staff quote uses.
   *
   * `persistAudit: false` is the one deviation, and it's deliberate: this
   * endpoint is anonymous and re-quotes on every date/room-type change a
   * browsing guest makes, so persisting would write one `rate_audit_log` row
   * PER NIGHT per interaction, driven by traffic nobody authenticated. The
   * trail exists to defend a disputed charge; a quote nobody booked has no
   * charge to dispute. The moment this guest actually books, the ordinary
   * `createReservation` path resolves again and DOES persist and link it.
   */
  async getQuote(slug: string, dto: PublicQuoteQueryDto): Promise<PublicQuote> {
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);
    const resolution = await this.rateResolverService.calculateQuote(
      tenantId,
      branchId,
      { roomTypeId: dto.roomTypeId, checkInDate: dto.checkInDate, checkOutDate: dto.checkOutDate, promoCode: dto.promoCode },
      null,
      { persistAudit: false },
    );
    const branch = await this.prisma.withTenant(tenantId, (tx) =>
      tx.branch.findFirstOrThrow({
        where: { id: branchId },
        select: { currency: true, timezone: true, checkInTime: true, cancellationPolicy: true },
      }),
    );
    const nights = Math.round((Date.parse(dto.checkOutDate) - Date.parse(dto.checkInDate)) / 86_400_000);
    // The terms this stay would book under, stated before the guest commits —
    // the one case worth spelling out is a stay starting so soon that
    // cancelling would already be charged.
    const policy = resolveCancellationPolicy(branch.cancellationPolicy);
    const terms = cancellationTermsFor(
      {
        status: 'confirmed',
        checkInDate: toBranchDate(dto.checkInDate),
        checkOutDate: toBranchDate(dto.checkOutDate),
        confirmedRate: resolution.subtotal,
        overrideRate: null,
      },
      branch,
      policy,
      new Date(),
    );
    return {
      currency: branch.currency,
      nightlyRate: resolution.nightlyRate.toFixed(2),
      subtotal: resolution.subtotal.toFixed(2),
      taxTotal: resolution.taxTotal.toFixed(2),
      totalWithTax: resolution.totalWithTax.toFixed(2),
      nights,
      cancellation: {
        summary: describeCancellationPolicy(policy, branch.checkInTime.toISOString().slice(11, 16), branch.currency),
        freeCancellationUntil: terms.freeUntil,
        freeCancellationAvailable: terms.withinFreeWindow,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Public write — the booking itself
  // ---------------------------------------------------------------------------

  /**
   * An ordinary reservation, created through the ordinary path. Everything
   * that protects an internal booking — capacity check, Revenue Management
   * restrictions, the `FOR UPDATE` room-type lock that closes the
   * double-book race, availability, the Rate Resolver cascade, confirmation
   * numbering, the audit row, the confirmation comms-log entry — applies
   * here unchanged, because this IS that path.
   *
   * Four values are forced server-side and can never come from the client:
   * `channel: 'direct'` (a public booking is direct by definition),
   * `joinWaitlist: false`, no `guestId`, and no `corporateAccountId`. See
   * `PublicCreateReservationDto`'s own comment for why each matters.
   *
   * `actorId` is `null` — a guest self-booking has no staff user, which is
   * exactly what `Reservation.createdBy`'s schema comment ("NULL = online
   * booking") anticipated at P0.
   */
  async createReservation(slug: string, dto: PublicCreateReservationDto): Promise<PublicBookingConfirmation> {
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);
    this.assertNotInThePast(dto.checkInDate);

    const reservation = await this.reservationsService.createReservation(
      tenantId,
      branchId,
      {
        roomTypeId: dto.roomTypeId,
        checkInDate: dto.checkInDate,
        checkOutDate: dto.checkOutDate,
        adults: dto.adults,
        children: dto.children,
        specialRequests: dto.specialRequests,
        promoCode: dto.promoCode,
        guest: { name: dto.guestName, email: dto.guestEmail, phone: dto.guestPhone },
        channel: 'direct',
        joinWaitlist: false,
      },
      null,
    );

    // After the booking has committed, in its own small write: consent is
    // about the guest, not the stay, and a booking must never fail because
    // of a marketing preference.
    if (dto.marketingOptIn) {
      await this.prisma.withTenant(tenantId, (tx) => this.recordMarketingOptIn(tx, reservation.guestId, 'booking_engine'));
    }

    return this.toConfirmation(tenantId, reservation);
  }

  /**
   * Only ever turns consent ON, and only for a guest who hasn't already
   * given it — so the date on file stays the date they first agreed. An
   * unticked box is not a withdrawal: a guest who opted in last year and books
   * again without ticking it stays opted in, and leaving is what the
   * unsubscribe link in every campaign is for.
   */
  private async recordMarketingOptIn(tx: TenantTx, guestId: string, source: 'booking_engine' | 'guest_portal'): Promise<void> {
    await tx.guestProfile.updateMany({
      where: { id: guestId, marketingOptIn: false, deletedAt: null },
      data: { marketingOptIn: true, marketingOptInAt: new Date(), marketingOptInSource: source },
    });
  }

  /**
   * A guest booking their own stay can't book one that already started —
   * the internal path deliberately allows a back-dated create (front desk
   * genuinely needs it to record a stay after the fact), so this guard
   * belongs here, on the public surface, rather than being pushed down into
   * the shared method where it would break that legitimate staff case.
   */
  private assertNotInThePast(checkInDate: string): void {
    const today = new Date().toISOString().slice(0, 10);
    if (checkInDate < today) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Check-in date cannot be in the past' });
    }
  }

  private async toConfirmation(tenantId: string, reservation: Reservation): Promise<PublicBookingConfirmation> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const full = await tx.reservation.findFirstOrThrow({
        where: { id: reservation.id },
        select: {
          confirmationNumber: true,
          checkInDate: true,
          checkOutDate: true,
          confirmedRate: true,
          roomType: { select: { name: true } },
          guest: { select: { name: true } },
          branch: { select: { currency: true } },
        },
      });
      return {
        confirmationNumber: full.confirmationNumber,
        checkInDate: full.checkInDate,
        checkOutDate: full.checkOutDate,
        roomTypeName: full.roomType.name,
        guestName: full.guest.name,
        totalRate: full.confirmedRate.toFixed(2),
        currency: full.branch.currency,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Guest self-service — looking up your own booking
  // ---------------------------------------------------------------------------

  /**
   * The one definition of "this caller has proved they own this booking",
   * shared by lookup and pre-arrival so the two can never drift apart — a
   * weaker check on the write path than the read path would be exactly the
   * kind of asymmetry that gets missed.
   *
   * `mode: 'insensitive'` rather than a lowercase compare: `GuestProfile
   * .email` is stored as entered, so a guest who typed "Ada@Example.com" at
   * booking must still match when they type it differently later.
   */
  private bookingCredentialsWhere(branchId: string, credentials: { confirmationNumber: string; email: string }) {
    return {
      branchId,
      confirmationNumber: credentials.confirmationNumber.trim().toUpperCase(),
      deletedAt: null,
      guest: { email: { equals: credentials.email.trim(), mode: 'insensitive' as const } },
    };
  }

  /**
   * "Manage my booking" for a guest who has a confirmation number and no
   * account. Scoped to a property because confirmation numbers are unique
   * per TENANT, not globally (`tenantId_confirmationNumber`) — the same
   * number can legitimately exist at another hotel, so a global lookup would
   * be ambiguous as well as leaky.
   *
   * A wrong confirmation number and a wrong email return the identical
   * "we couldn't find that booking" 404. Distinguishing them would confirm
   * which confirmation numbers exist, and since they're sequential that turns
   * the endpoint into an enumeration oracle.
   *
   * Returns strictly what the guest already knows or is entitled to see —
   * never internal ids, never another guest, never staff notes or financial
   * internals. The guest's bill is a separate call: see `getGuestFolio`.
   */
  async lookupBooking(slug: string, dto: LookupBookingDto): Promise<PublicBookingDetail> {
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);

    const reservation = await this.prisma.withTenant(tenantId, (tx) =>
      tx.reservation.findFirst({
        where: this.bookingCredentialsWhere(branchId, dto),
        select: {
          confirmationNumber: true,
          status: true,
          checkInDate: true,
          checkOutDate: true,
          adults: true,
          children: true,
          specialRequests: true,
          confirmedRate: true,
          overrideRate: true,
          preArrivalCompletedAt: true,
          estimatedArrivalTime: true,
          cancellationPolicy: true,
          roomType: { select: { name: true } },
          guest: { select: { name: true, email: true, phone: true, nationality: true } },
          branch: { select: { currency: true, regCardTemplate: true } },
        },
      }),
    );

    if (!reservation) throw this.bookingNotFound();

    const property = await this.getProperty(slug);

    return {
      confirmationNumber: reservation.confirmationNumber,
      status: reservation.status,
      checkInDate: reservation.checkInDate,
      checkOutDate: reservation.checkOutDate,
      adults: reservation.adults,
      children: reservation.children,
      specialRequests: reservation.specialRequests,
      roomTypeName: reservation.roomType.name,
      guestName: reservation.guest.name,
      guestEmail: reservation.guest.email,
      guestPhone: reservation.guest.phone,
      guestNationality: reservation.guest.nationality,
      // The stay total the guest agreed to. `overrideRate` is a NIGHTLY
      // absolute set by staff (group blocks, manager overrides), so it can't
      // be shown as a stay total — `confirmedRate` already reflects it.
      totalRate: reservation.confirmedRate.toFixed(2),
      currency: reservation.branch.currency,
      preArrivalCompletedAt: reservation.preArrivalCompletedAt,
      estimatedArrivalTime: reservation.estimatedArrivalTime,
      // The property's own house rules, so the guest can actually read what
      // they're being asked to accept. Only this one field is surfaced from
      // `regCardTemplate` — the rest of it (logo, required-field config,
      // language) is staff-facing setup, not something a guest needs.
      houseRules: ((reservation.branch.regCardTemplate ?? {}) as { houseRules?: string }).houseRules ?? null,
      // The terms THIS booking was made under — which may differ from what the
      // property offers new bookings today. Older bookings have no snapshot and
      // use the property's current policy, exactly as a cancellation would.
      cancellationPolicySummary: reservation.cancellationPolicy
        ? describeCancellationPolicy(resolveCancellationPolicy(reservation.cancellationPolicy), property.checkInTime, reservation.branch.currency)
        : property.cancellationPolicy.summary,
      property,
    };
  }

  /**
   * Guest pre-arrival check-in. Same credentials as the lookup — deliberately
   * the same `bookingCredentialsWhere`, so the write path can never end up
   * easier to pass than the read path.
   *
   * Corrected contact details are written to the guest's own `GuestProfile`
   * rather than copied onto the reservation, because the registration card
   * generated at check-in snapshots that record at that moment. A guest
   * fixing their phone number here therefore flows through to the card with
   * no extra plumbing, which is the whole point of the feature.
   *
   * Only forward-looking states accept a pre-arrival: someone already checked
   * in, checked out, cancelled or no-showed has nothing to pre-arrive for,
   * and silently accepting it would write misleading data onto a closed stay.
   */
  async preArrivalCheckIn(slug: string, dto: PreArrivalCheckInDto): Promise<PublicBookingDetail> {
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);

    if (!dto.acceptHouseRules) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'The house rules must be accepted to complete check-in' });
    }

    await this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await tx.reservation.findFirst({
        where: this.bookingCredentialsWhere(branchId, dto),
        select: { id: true, guestId: true, status: true },
      });
      if (!reservation) throw this.bookingNotFound();

      if (!PRE_ARRIVAL_ELIGIBLE_STATUSES.has(reservation.status)) {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: 'This booking can no longer be checked in online — please speak to the property directly',
        });
      }

      const guestUpdates: { phone?: string; nationality?: string } = {};
      if (dto.phone?.trim()) guestUpdates.phone = dto.phone.trim();
      if (dto.nationality?.trim()) guestUpdates.nationality = dto.nationality.trim().toUpperCase();
      if (Object.keys(guestUpdates).length > 0) {
        await tx.guestProfile.update({ where: { id: reservation.guestId }, data: guestUpdates });
      }
      if (dto.marketingOptIn) {
        await this.recordMarketingOptIn(tx, reservation.guestId, 'guest_portal');
      }

      const now = new Date();
      await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          preArrivalCompletedAt: now,
          houseRulesAcceptedAt: now,
          estimatedArrivalTime: dto.estimatedArrivalTime ?? null,
        },
      });

      // `userId: null` — a guest acted, not a staff member, the same way a
      // public booking records `createdBy: null`. The audit row still exists
      // because "who changed this guest's phone number and when" is exactly
      // the sort of question a dispute asks later.
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId,
          userId: null,
          action: 'reservation.pre_arrival_completed',
          entityType: 'reservation',
          entityId: reservation.id,
          after: { estimatedArrivalTime: dto.estimatedArrivalTime ?? null, updatedGuestFields: Object.keys(guestUpdates) },
        },
      });
    });

    // Re-read through the ordinary lookup so the guest gets back exactly the
    // same shape they'd see on a refresh, rather than a hand-built echo that
    // could drift from it.
    return this.lookupBooking(slug, { confirmationNumber: dto.confirmationNumber, email: dto.email });
  }

  // ---------------------------------------------------------------------------
  // Guest self-service — cancelling your own booking
  // ---------------------------------------------------------------------------

  /**
   * What cancelling would cost the guest right now. The figures are
   * `ReservationsService`'s own quote — the one the staff Cancel page shows —
   * projected to what a guest needs.
   */
  async getCancellationQuote(slug: string, dto: LookupBookingDto): Promise<PublicCancellationQuote> {
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);
    const property = await this.getProperty(slug);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await tx.reservation.findFirst({
        where: this.bookingCredentialsWhere(branchId, dto),
        select: { id: true, confirmationNumber: true, status: true },
      });
      if (!reservation) throw this.bookingNotFound();
      this.assertGuestCancellable(reservation.status);

      const quote = await this.reservationsService.quoteCancellationInTx(tx, reservation.id, new Date());
      const blockedReason = this.onlineCancellationBlock(quote, property.name);
      return {
        confirmationNumber: reservation.confirmationNumber,
        currency: quote.currency,
        canCancelOnline: blockedReason === null,
        blockedReason,
        policySummary: quote.policy.summary,
        freeCancellationUntil: quote.freeCancellationUntil,
        withinFreeWindow: quote.withinFreeWindow,
        charge: { amount: quote.penaltyAmount, tax: quote.penaltyTax, total: quote.penaltyTotal },
        paidSoFar: quote.paidSoFar,
        refundDue: quote.refundDue,
      };
    });
  }

  /**
   * The guest cancels their own booking — through `ReservationsService
   * .cancelInTx`, the same path a front-desk cancellation takes, so the
   * policy can't be applied differently online. Same credentials as the
   * lookup; the guest's own two gates (online cancellation allowed, not yet
   * past check-in) are checked first, and the charge they acknowledged must
   * match the one recomputed here.
   *
   * `actorId: null` — a guest acted, not a staff member, like a public
   * booking's `createdBy: null`.
   */
  async cancelBooking(slug: string, dto: CancelBookingDto): Promise<PublicCancellationResult> {
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);
    const property = await this.getProperty(slug);
    const now = new Date();

    const charged = await this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await tx.reservation.findFirst({
        where: this.bookingCredentialsWhere(branchId, dto),
        select: { id: true, status: true },
      });
      if (!reservation) throw this.bookingNotFound();
      this.assertGuestCancellable(reservation.status);

      const quote = await this.reservationsService.quoteCancellationInTx(tx, reservation.id, now);
      const blockedReason = this.onlineCancellationBlock(quote, property.name);
      if (blockedReason) throw new ConflictException({ code: ErrorCode.CONFLICT, message: blockedReason });

      const result = await this.reservationsService.cancelInTx(tx, tenantId, reservation.id, {
        actorId: null,
        source: 'guest',
        reason: dto.reason?.trim() || undefined,
        acknowledgedPenaltyTotal: dto.acknowledgedPenaltyTotal,
        now,
      });
      return result.charged;
    });

    return {
      booking: await this.lookupBooking(slug, { confirmationNumber: dto.confirmationNumber, email: dto.email }),
      charged: charged.toFixed(2),
      currency: property.currency,
    };
  }

  private assertGuestCancellable(status: string): void {
    if (!CANCELLABLE_STATUSES.has(status)) {
      throw new ConflictException({
        code: ErrorCode.INVALID_STATUS_TRANSITION,
        message: 'This booking can no longer be cancelled online — please speak to the property directly',
      });
    }
  }

  /**
   * Why a guest can't cancel online, or `null` if they can. Past check-in
   * time on the arrival day the stay is due to have started: from then on
   * it's a no-show matter for the property, not a self-service cancel — and
   * letting a guest cancel at 11pm would let them sidestep a stricter
   * no-show penalty.
   */
  private onlineCancellationBlock(quote: CancellationQuote, propertyName: string): string | null {
    if (!quote.policy.allowOnlineCancellation) {
      return `${propertyName} doesn't take cancellations online — please contact the property directly to cancel.`;
    }
    if (quote.pastCheckInTime) {
      return `It's past check-in time on your arrival day, so this booking can't be cancelled online any more — please contact ${propertyName} directly.`;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Guest self-service — messaging the property (Month 9 unified inbox)
  // ---------------------------------------------------------------------------

  /** The guest's conversation about this booking. Read-only — nothing here marks anything seen. */
  async getGuestMessages(slug: string, dto: LookupBookingDto): Promise<PublicMessageThread> {
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);
    const property = await this.getProperty(slug);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await tx.reservation.findFirst({
        where: this.bookingCredentialsWhere(branchId, dto),
        select: { id: true, confirmationNumber: true },
      });
      if (!reservation) throw this.bookingNotFound();
      const rows = await this.commsLogService.guestThreadInTx(tx, reservation.id);
      return { confirmationNumber: reservation.confirmationNumber, propertyName: property.name, messages: rows.map(toPublicMessage) };
    });
  }

  /**
   * A guest writes to the property — the first real inbound channel of the
   * unified inbox, and the one that works without any provider account. The
   * message is an ordinary comms-log row (`direction: 'inbound'`), so it
   * threads with everything else the property has sent this guest.
   *
   * A housekeeping request from a guest who's actually in a room also goes
   * straight onto the housekeeping task board — the plan's "lands as a
   * HousekeepingTask", not a message someone has to remember to forward.
   * Anything else (a late check-out has a price; a question needs a person)
   * waits in the inbox for staff.
   */
  async sendGuestMessage(slug: string, dto: GuestMessageDto): Promise<PublicMessageSent> {
    const body = dto.body.trim();
    if (!body) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Write a message before sending' });
    }
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);
    const property = await this.getProperty(slug);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await tx.reservation.findFirst({
        where: this.bookingCredentialsWhere(branchId, dto),
        select: { id: true, confirmationNumber: true, guestId: true, status: true, roomId: true, branch: { select: { timezone: true } } },
      });
      if (!reservation) throw this.bookingNotFound();

      await this.commsLogService.logGuestMessageInTx(tx, tenantId, branchId, {
        reservationId: reservation.id,
        guestId: reservation.guestId,
        body,
        requestType: dto.requestType,
      });

      let housekeepingTaskCreated = false;
      if (dto.requestType === 'housekeeping' && reservation.status === 'checked_in' && reservation.roomId) {
        await this.housekeepingService.createTaskInTx(tx, tenantId, branchId, {
          roomId: reservation.roomId,
          priority: 2,
          notes: `Guest request (${reservation.confirmationNumber}): ${body}`.slice(0, 1000),
          triggerEvent: 'guest_request',
          triggeredByReservationId: reservation.id,
          taskDate: toBranchDate(todayInTimezone(reservation.branch.timezone)),
          // A guest acted, not a staff member — the same NULL a public booking's `createdBy` uses.
          actorId: null,
        });
        housekeepingTaskCreated = true;
      }

      const rows = await this.commsLogService.guestThreadInTx(tx, reservation.id);
      return { confirmationNumber: reservation.confirmationNumber, propertyName: property.name, messages: rows.map(toPublicMessage), housekeepingTaskCreated };
    });
  }

  // ---------------------------------------------------------------------------
  // Guest self-service — a read-only view of your own bill
  // ---------------------------------------------------------------------------

  /**
   * The guest's own bill (growth plan Month 9, "read-only folio view").
   *
   * No new money calculation: the totals ARE `FoliosService.getFolio`'s own
   * `computeTotals` result, passed through untouched. What this method adds
   * is only a projection — and one filter that the projection genuinely
   * needs. `getFolio` hides deleted rows from its lists but deliberately keeps
   * VOIDED ones (staff need to see what was voided), while `computeTotals`
   * excludes voided rows from the balance. Handing those lists to a guest
   * as-is would show a charge the total doesn't include, and the bill wouldn't
   * add up. Filtering `isVoid` here applies the exact rule `computeTotals`
   * uses, so the lines and payments sum to the totals by construction.
   *
   * Only the PRIMARY folio (`label: null`). Split-billing folios can carry a
   * different payer — a company account, say — so a guest learns only that
   * one exists, never what's on it.
   *
   * Never calls `ensurePrimaryFolio`. That method creates a folio when none
   * exists, and an anonymous read must not write; a checked-in stay that
   * somehow has no folio gets told so rather than having one conjured up.
   */
  async getGuestFolio(slug: string, dto: LookupBookingDto): Promise<PublicGuestFolio> {
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);

    const { reservation, primaryFolioId, otherFolioCount } = await this.prisma.withTenant(tenantId, async (tx) => {
      const found = await tx.reservation.findFirst({
        where: this.bookingCredentialsWhere(branchId, dto),
        select: { id: true, status: true, confirmationNumber: true, confirmedRate: true },
      });
      if (!found) throw this.bookingNotFound();

      // Past this point the caller has proved they own the booking, so a
      // specific message leaks nothing — unlike the credential failure above.
      if (!FOLIO_VISIBLE_STATUSES.has(found.status)) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'Your bill will be available here once you have checked in' });
      }

      const primary = await tx.folio.findFirst({ where: { reservationId: found.id, label: null, deletedAt: null }, select: { id: true } });
      const others = await tx.folio.count({ where: { reservationId: found.id, deletedAt: null, label: { not: null } } });
      return { reservation: found, primaryFolioId: primary?.id ?? null, otherFolioCount: others };
    });

    if (!primaryFolioId) {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: "Your bill isn't available online yet — please ask the front desk" });
    }

    const folio = await this.foliosService.getFolio(tenantId, primaryFolioId);
    const stillAccruing = reservation.status === 'checked_in';

    return {
      confirmationNumber: reservation.confirmationNumber,
      currency: folio.currency,
      lineItems: folio.lineItems
        .filter((item) => !item.isVoid)
        .map((item) => ({
          description: item.description,
          chargeType: item.chargeType,
          amount: item.amount.toFixed(2),
          serviceDate: item.serviceDate,
          postedAt: item.postedAt,
        })),
      payments: folio.payments
        .filter((payment) => !payment.isVoid)
        .map((payment) => ({
          method: payment.method,
          purpose: payment.paymentPurpose,
          amount: payment.amount.toFixed(2),
          recordedAt: payment.recordedAt,
        })),
      subTotal: folio.totals.subTotal.toFixed(2),
      taxTotal: folio.totals.taxTotal.toFixed(2),
      totalCost: folio.totals.totalCost.toFixed(2),
      paymentsTotal: folio.totals.paymentsTotal.toFixed(2),
      balanceDue: folio.totals.balanceDue.toFixed(2),
      stillAccruing,
      roomTotalForStay: stillAccruing ? reservation.confirmedRate.toFixed(2) : null,
      otherFoliosExist: otherFolioCount > 0,
      asOf: new Date(),
    };
  }

  // ---------------------------------------------------------------------------
  // Owner/Manager controls — publishing a property to the booking engine
  // ---------------------------------------------------------------------------

  /**
   * Authenticated (Owner/Manager), unlike everything above. Writes the real
   * branch row and the non-RLS pointer together so the two can never drift:
   * the pointer row exists if and only if the branch is published with this
   * slug.
   */
  async publish(tenantId: string, branchId: string, dto: PublishBookingEngineDto): Promise<{ slug: string; bookingEngineEnabled: true }> {
    const existing = await this.prisma.bookingSlugIndex.findUnique({ where: { slug: dto.slug } });
    if (existing && existing.branchId !== branchId) {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'That booking address is already taken' });
    }

    await this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await tx.branch.findFirst({ where: { id: branchId, deletedAt: null }, select: { id: true } });
      if (!branch) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Branch not found' });
      await tx.branch.update({ where: { id: branchId }, data: { bookingSlug: dto.slug, bookingEngineEnabled: true } });
    });

    // Clear any previous slug this branch held before claiming the new one,
    // so an old public URL stops resolving instead of lingering as a second
    // live address for the same property.
    await this.prisma.bookingSlugIndex.deleteMany({ where: { branchId } });
    await this.prisma.bookingSlugIndex.create({ data: { slug: dto.slug, tenantId, branchId } });

    return { slug: dto.slug, bookingEngineEnabled: true };
  }

  /** Unpublishing keeps the branch's chosen slug on the branch row (so it isn't released to someone else) but removes the pointer, making it immediately unresolvable. */
  async unpublish(tenantId: string, branchId: string): Promise<{ bookingEngineEnabled: false }> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await tx.branch.findFirst({ where: { id: branchId, deletedAt: null }, select: { id: true } });
      if (!branch) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Branch not found' });
      await tx.branch.update({ where: { id: branchId }, data: { bookingEngineEnabled: false } });
    });
    await this.prisma.bookingSlugIndex.deleteMany({ where: { branchId } });
    return { bookingEngineEnabled: false };
  }

  async getBookingEngineStatus(tenantId: string, branchId: string): Promise<{ slug: string | null; bookingEngineEnabled: boolean }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await tx.branch.findFirst({ where: { id: branchId, deletedAt: null }, select: { bookingSlug: true, bookingEngineEnabled: true } });
      if (!branch) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Branch not found' });
      return { slug: branch.bookingSlug, bookingEngineEnabled: branch.bookingEngineEnabled };
    });
  }
}
