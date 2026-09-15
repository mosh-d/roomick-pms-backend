import { Body, Controller, Delete, ExecutionContext, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentTenant } from '../../common/decorators';
import { Public } from '../../common/decorators/public.decorator';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
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
import { PublicBookingService, PublicBookingConfirmation, PublicPropertyInfo, PublicRoomType } from './public-booking.service';

/**
 * The storage key for the guest-credential budget: the same for every route
 * that uses it, so they share ONE count per IP. (The throttler's default key
 * includes the controller and handler names, giving each route its own.)
 */
export function guestCredentialsThrottleKey(_context: ExecutionContext, tracker: string, throttlerName: string): string {
  return `guest-credentials:${throttlerName}:${tracker}`;
}

/**
 * ONE budget per IP across every route that takes a confirmation number and
 * an email. Each of those routes answers a right pair differently from a
 * wrong one, so each is a guessing oracle — and with separate per-route
 * buckets, every route added (bill, cancellation, messages…) handed an
 * attacker another 10 guesses an hour. Sharing the key caps the total
 * instead. Comfortable for a real guest: a whole session — look up, view the
 * bill, message the desk, cancel — is well under 20.
 */
const GUEST_CREDENTIALS_THROTTLE = { default: { limit: 20, ttl: 3_600_000, generateKey: guestCredentialsThrottleKey } };

/**
 * The Direct Booking Engine's guest-facing API (Month 7).
 *
 * Every route here is `@Public()` — no JWT, no `X-Tenant-ID` header — which
 * makes it the widest attack surface in the app, so each one is deliberately
 * constrained:
 *
 *  - No `@Roles()` anywhere on this controller. `RolesGuard` passes a route
 *    through only when no roles are required, and a public route has no
 *    `request.user` to check against in the first place.
 *  - Tenant context is never taken from the request. It's resolved from the
 *    booking slug server-side, then every read/write runs inside the normal
 *    RLS transaction.
 *  - Tighter per-IP throttling than the app-wide 100/min default, tightest on
 *    the one route that writes (`reservations`).
 *
 * Owner/Manager publish controls live on a SEPARATE controller below, so a
 * class-level `@Public()` can never accidentally extend to them.
 */
@ApiTags('public-booking')
@Controller('public/properties')
@Public()
export class PublicBookingController {
  constructor(private readonly publicBookingService: PublicBookingService) {}

  @Get(':slug')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Public property detail for the booking widget — name, brand, address, currency, check-in/out times' })
  getProperty(@Param('slug') slug: string): Promise<PublicPropertyInfo> {
    return this.publicBookingService.getProperty(slug);
  }

  @Get(':slug/room-types')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Bookable room types with starting rates, bed type, size, amenities and photos' })
  listRoomTypes(@Param('slug') slug: string): Promise<PublicRoomType[]> {
    return this.publicBookingService.listRoomTypes(slug);
  }

  @Get(':slug/availability')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Per-night availability — the same computation the internal availability screen uses' })
  getAvailability(@Param('slug') slug: string, @Query() dto: PublicAvailabilityQueryDto): ReturnType<PublicBookingService['getAvailability']> {
    return this.publicBookingService.getAvailability(slug, dto);
  }

  @Get(':slug/quote')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'A real Rate Resolver quote through the same cascade a staff quote uses — never a separate "direct rate" table' })
  getQuote(@Param('slug') slug: string, @Query() dto: PublicQuoteQueryDto): ReturnType<PublicBookingService['getQuote']> {
    return this.publicBookingService.getQuote(slug, dto);
  }

  @Post(':slug/bookings/lookup')
  // 200, not Nest's default 201 for POST. This route creates nothing — it's a
  // read that uses POST only to keep the confirmation number and email out of
  // the URL. Returning "201 Created" would misdescribe it to any client.
  @HttpCode(HttpStatus.OK)
  // A POST, not a GET, specifically because the body carries a confirmation
  // number plus an email address: query strings land in server access logs,
  // browser history and `Referer` headers, and these shouldn't.
  //
  // Confirmation numbers are sequential, so brute force is plausible here and
  // on every other route that checks the same credentials — they all draw on
  // one shared per-IP budget (GUEST_CREDENTIALS_THROTTLE above), which makes
  // guessing useless while leaving a real guest who mistypes their email
  // several attempts.
  @Throttle(GUEST_CREDENTIALS_THROTTLE)
  @ApiOperation({ summary: 'Guest self-service — look up your own booking with its confirmation number and the email address on it' })
  lookupBooking(@Param('slug') slug: string, @Body() dto: LookupBookingDto): ReturnType<PublicBookingService['lookupBooking']> {
    return this.publicBookingService.lookupBooking(slug, dto);
  }

  @Post(':slug/bookings/pre-arrival')
  @HttpCode(HttpStatus.OK)
  // Same credentials as the lookup — the same shared budget.
  @Throttle(GUEST_CREDENTIALS_THROTTLE)
  @ApiOperation({ summary: 'Guest pre-arrival check-in — corrects contact details and accepts house rules before arrival, so the desk only has to confirm and assign a room' })
  preArrivalCheckIn(@Param('slug') slug: string, @Body() dto: PreArrivalCheckInDto): ReturnType<PublicBookingService['preArrivalCheckIn']> {
    return this.publicBookingService.preArrivalCheckIn(slug, dto);
  }

  @Post(':slug/bookings/folio')
  @HttpCode(HttpStatus.OK)
  // Same credentials as the lookup — the same shared budget. Read-only:
  // nothing here can post, pay or change a charge.
  @Throttle(GUEST_CREDENTIALS_THROTTLE)
  @ApiOperation({ summary: "Guest self-service — a read-only view of your own bill: charges posted so far, payments and balance. Primary folio only." })
  getGuestFolio(@Param('slug') slug: string, @Body() dto: LookupBookingDto): ReturnType<PublicBookingService['getGuestFolio']> {
    return this.publicBookingService.getGuestFolio(slug, dto);
  }

  @Post(':slug/bookings/cancellation-quote')
  @HttpCode(HttpStatus.OK)
  // Same credentials as the lookup — the same shared budget. Read-only.
  @Throttle(GUEST_CREDENTIALS_THROTTLE)
  @ApiOperation({ summary: "Guest self-service — what cancelling this booking now would cost under the property's cancellation policy" })
  getCancellationQuote(@Param('slug') slug: string, @Body() dto: LookupBookingDto): ReturnType<PublicBookingService['getCancellationQuote']> {
    return this.publicBookingService.getCancellationQuote(slug, dto);
  }

  @Post(':slug/bookings/cancel')
  @HttpCode(HttpStatus.OK)
  // A write behind the same credentials — the same shared budget.
  @Throttle(GUEST_CREDENTIALS_THROTTLE)
  @ApiOperation({ summary: 'Guest self-cancellation — the same cancellation path staff use; the guest confirms the exact charge they were shown' })
  cancelBooking(@Param('slug') slug: string, @Body() dto: CancelBookingDto): ReturnType<PublicBookingService['cancelBooking']> {
    return this.publicBookingService.cancelBooking(slug, dto);
  }

  @Post(':slug/bookings/messages')
  @HttpCode(HttpStatus.OK)
  // Same credentials as the lookup — the same shared budget. Read-only.
  @Throttle(GUEST_CREDENTIALS_THROTTLE)
  @ApiOperation({ summary: 'Guest self-service — your conversation with the property about this booking' })
  getGuestMessages(@Param('slug') slug: string, @Body() dto: LookupBookingDto): ReturnType<PublicBookingService['getGuestMessages']> {
    return this.publicBookingService.getGuestMessages(slug, dto);
  }

  @Post(':slug/bookings/messages/send')
  @HttpCode(HttpStatus.OK)
  // A write behind the same credentials — the same shared budget, which also
  // caps how fast one IP can fill a property's inbox.
  @Throttle(GUEST_CREDENTIALS_THROTTLE)
  @ApiOperation({ summary: 'Guest self-service — message the property, optionally as a late check-out or housekeeping request' })
  sendGuestMessage(@Param('slug') slug: string, @Body() dto: GuestMessageDto): ReturnType<PublicBookingService['sendGuestMessage']> {
    return this.publicBookingService.sendGuestMessage(slug, dto);
  }

  @Post(':slug/reservations')
  // The only public write. 10/hour per IP is generous for a real guest (who
  // books once) and hostile to a bot creating junk reservations against a
  // property's live inventory.
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'Guest self-books — an ordinary Reservation through the ordinary create path, channel forced to "direct", createdBy NULL' })
  createReservation(@Param('slug') slug: string, @Body() dto: PublicCreateReservationDto): Promise<PublicBookingConfirmation> {
    return this.publicBookingService.createReservation(slug, dto);
  }
}

/**
 * Authenticated counterpart — publishing a property to the booking engine.
 * Separate class specifically so the `@Public()` above can't leak onto it.
 */
@ApiTags('public-booking')
@ApiBearerAuth()
@Controller()
@Roles(SystemRole.Owner, SystemRole.Manager)
export class BookingEngineAdminController {
  constructor(private readonly publicBookingService: PublicBookingService) {}

  @Get('branches/:branchId/booking-engine')
  @ApiOperation({ summary: "This branch's public booking address and whether it's currently published" })
  getStatus(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string): ReturnType<PublicBookingService['getBookingEngineStatus']> {
    return this.publicBookingService.getBookingEngineStatus(tenantId, branchId);
  }

  @Put('branches/:branchId/booking-engine')
  @ApiOperation({ summary: 'Publish this branch to the Direct Booking Engine at the given public slug' })
  publish(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: PublishBookingEngineDto,
  ): ReturnType<PublicBookingService['publish']> {
    return this.publicBookingService.publish(tenantId, branchId, dto);
  }

  @Delete('branches/:branchId/booking-engine')
  @ApiOperation({ summary: 'Unpublish — the public URL stops resolving immediately, but the slug stays reserved to this branch' })
  unpublish(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string): ReturnType<PublicBookingService['unpublish']> {
    return this.publicBookingService.unpublish(tenantId, branchId);
  }
}
