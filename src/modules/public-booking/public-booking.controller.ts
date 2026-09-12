import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentTenant } from '../../common/decorators';
import { Public } from '../../common/decorators/public.decorator';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import {
  PublicAvailabilityQueryDto,
  PublicCreateReservationDto,
  PublicQuoteQueryDto,
  PublishBookingEngineDto,
} from './dto/public-booking.dto';
import { PublicBookingService, PublicBookingConfirmation, PublicPropertyInfo, PublicRoomType } from './public-booking.service';

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
