import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Reservation } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { toBranchDate } from '../../common/utils/branch-date';
import { PrismaService } from '../../prisma/prisma.service';
import { RateResolverService } from '../rate-resolver/rate-resolver.service';
import { ReservationsService } from '../reservations/reservations.service';
import { PublicAvailabilityQueryDto, PublicCreateReservationDto, PublicQuoteQueryDto, PublishBookingEngineDto } from './dto/public-booking.dto';

/** A tenant in one of these states has stopped paying for / closed its account — its properties stop accepting public bookings. */
const BOOKABLE_TENANT_STATUSES = new Set(['trial', 'active']);

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

export interface PublicBookingConfirmation {
  confirmationNumber: string;
  checkInDate: Date;
  checkOutDate: Date;
  roomTypeName: string;
  guestName: string;
  totalRate: string;
  currency: string;
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

  // ---------------------------------------------------------------------------
  // Public reads
  // ---------------------------------------------------------------------------

  /**
   * Public-safe property detail only. Explicitly NOT returned: tenant id,
   * branch id, internal policies, no-show policy, reg-card template,
   * overbooking configuration, staff, or anything financial.
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
          brand: { select: { name: true } },
        },
      });
      return {
        slug,
        name: branch.name,
        category: branch.category,
        currency: branch.currency,
        timezone: branch.timezone,
        // Stored as a Postgres TIME, surfaced by Prisma as a 1970-01-01
        // DateTime — only the time-of-day half is meaningful.
        checkInTime: branch.checkInTime.toISOString().slice(11, 16),
        checkOutTime: branch.checkOutTime.toISOString().slice(11, 16),
        address: branch.address,
        brandName: branch.brand.name,
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
  async getQuote(slug: string, dto: PublicQuoteQueryDto): Promise<{ currency: string; nightlyRate: string; subtotal: string; taxTotal: string; totalWithTax: string; nights: number }> {
    const { tenantId, branchId } = await this.resolveBookableBranch(slug);
    const resolution = await this.rateResolverService.calculateQuote(
      tenantId,
      branchId,
      { roomTypeId: dto.roomTypeId, checkInDate: dto.checkInDate, checkOutDate: dto.checkOutDate, promoCode: dto.promoCode },
      null,
      { persistAudit: false },
    );
    const branch = await this.prisma.withTenant(tenantId, (tx) => tx.branch.findFirstOrThrow({ where: { id: branchId }, select: { currency: true } }));
    const nights = Math.round((Date.parse(dto.checkOutDate) - Date.parse(dto.checkInDate)) / 86_400_000);
    return {
      currency: branch.currency,
      nightlyRate: resolution.nightlyRate.toFixed(2),
      subtotal: resolution.subtotal.toFixed(2),
      taxTotal: resolution.taxTotal.toFixed(2),
      totalWithTax: resolution.totalWithTax.toFixed(2),
      nights,
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

    return this.toConfirmation(tenantId, reservation);
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
