import { Module } from '@nestjs/common';
import { RegistrationCardsController } from './registration-cards.controller';
import { RegistrationCardsService } from './registration-cards.service';

@Module({
  controllers: [RegistrationCardsController],
  providers: [RegistrationCardsService],
  exports: [RegistrationCardsService],
})
export class RegistrationCardsModule {}
