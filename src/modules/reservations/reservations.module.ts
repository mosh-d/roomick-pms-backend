import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { GuestsModule } from '../guests/guests.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [PropertyModule, GuestsModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
