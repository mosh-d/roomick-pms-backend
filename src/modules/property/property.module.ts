import { Module } from '@nestjs/common';
import { PropertyController } from './property.controller';
import { PropertyService } from './property.service';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

@Module({
  controllers: [PropertyController, RoomsController],
  providers: [PropertyService, RoomsService],
  exports: [PropertyService, RoomsService],
})
export class PropertyModule {}
