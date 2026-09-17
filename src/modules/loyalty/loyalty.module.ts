import { Module } from '@nestjs/common';
import { CommsLogModule } from '../comms-log/comms-log.module';
import { FoliosModule } from '../folios/folios.module';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';

@Module({
  imports: [FoliosModule, CommsLogModule],
  controllers: [LoyaltyController],
  providers: [LoyaltyService],
  exports: [LoyaltyService],
})
export class LoyaltyModule {}
