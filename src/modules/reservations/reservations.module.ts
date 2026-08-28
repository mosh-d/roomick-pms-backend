import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { GuestsModule } from '../guests/guests.module';
import { FoliosModule } from '../folios/folios.module';
import { HousekeepingModule } from '../housekeeping/housekeeping.module';
import { RateResolverModule } from '../rate-resolver/rate-resolver.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [PropertyModule, GuestsModule, FoliosModule, HousekeepingModule, RateResolverModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
