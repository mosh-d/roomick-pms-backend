import { Module } from '@nestjs/common';
import { RateResolverModule } from '../rate-resolver/rate-resolver.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { BookingEngineAdminController, PublicBookingController } from './public-booking.controller';
import { PublicBookingService } from './public-booking.service';

/**
 * Direct Booking Engine (Month 7). Imports `ReservationsModule` and
 * `RateResolverModule` and composes them unmodified — a guest booking is an
 * ordinary reservation and a guest quote is an ordinary Rate Resolver
 * resolution, so there is no parallel booking or pricing system here.
 */
@Module({
  imports: [ReservationsModule, RateResolverModule],
  controllers: [PublicBookingController, BookingEngineAdminController],
  providers: [PublicBookingService],
})
export class PublicBookingModule {}
