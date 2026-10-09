import { Module } from '@nestjs/common';
import { PropertyController } from './property.controller';
import { PropertyService } from './property.service';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { RoomHoldsScheduler } from './room-holds.scheduler';
import { RoomPhotosController } from './room-photos.controller';

@Module({
  controllers: [PropertyController, RoomsController, RoomPhotosController],
  providers: [PropertyService, RoomsService, RoomHoldsScheduler],
  exports: [PropertyService, RoomsService],
})
export class PropertyModule {}
