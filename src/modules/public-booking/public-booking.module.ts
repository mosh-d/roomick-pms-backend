import { Module } from '@nestjs/common';
import { CommsLogModule } from '../comms-log/comms-log.module';
import { FoliosModule } from '../folios/folios.module';
import { HousekeepingModule } from '../housekeeping/housekeeping.module';
import { RateResolverModule } from '../rate-resolver/rate-resolver.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { BookingEngineAdminController, PublicBookingController } from './public-booking.controller';
import { PublicBookingService } from './public-booking.service';

/**
 * Direct Booking Engine (Month 7). Imports `ReservationsModule` and
 * `RateResolverModule` and composes them unmodified — a guest booking is an
 * ordinary reservation and a guest quote is an ordinary Rate Resolver
 * resolution, so there is no parallel booking or pricing system here.
 * `FoliosModule` likewise: a guest's bill is `FoliosService.getFolio`'s own
 * response, projected down to guest-safe fields — no second money calculation.
 * `CommsLogModule` and `HousekeepingModule` for guest messages: a message is a
 * comms-log row like any other, and a housekeeping request is an ordinary task.
 */
@Module({
  imports: [ReservationsModule, RateResolverModule, FoliosModule, CommsLogModule, HousekeepingModule],
  controllers: [PublicBookingController, BookingEngineAdminController],
  providers: [PublicBookingService],
})
export class PublicBookingModule {}
