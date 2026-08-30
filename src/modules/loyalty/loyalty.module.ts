import { Module } from '@nestjs/common';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';

@Module({
  controllers: [LoyaltyController],
  providers: [LoyaltyService],
})
export class LoyaltyModule {}
