import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module';
import { TaxesModule } from '../taxes/taxes.module';
import { SalesEventsController } from './sales-events.controller';
import { GroupBlocksService } from './group-blocks.service';
import { EventSpacesService } from './event-spaces.service';

@Module({
  imports: [ReservationsModule, TaxesModule],
  controllers: [SalesEventsController],
  providers: [GroupBlocksService, EventSpacesService],
})
export class SalesEventsModule {}
