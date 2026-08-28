import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { UsersModule } from '../users/users.module';
import { HousekeepingController } from './housekeeping.controller';
import { HousekeepingService } from './housekeeping.service';

@Module({
  imports: [PropertyModule, UsersModule],
  controllers: [HousekeepingController],
  providers: [HousekeepingService],
  exports: [HousekeepingService],
})
export class HousekeepingModule {}
