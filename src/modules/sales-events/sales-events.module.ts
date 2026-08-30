import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module';
import { SalesEventsController } from './sales-events.controller';
import { GroupBlocksService } from './group-blocks.service';
import { EventSpacesService } from './event-spaces.service';

@Module({
  imports: [ReservationsModule],
  controllers: [SalesEventsController],
  providers: [GroupBlocksService, EventSpacesService],
})
export class SalesEventsModule {}
