import { Module } from '@nestjs/common';
import { CorporateAccountsController } from './corporate-accounts.controller';
import { CorporateAccountsService } from './corporate-accounts.service';
import { GuestsController } from './guests.controller';
import { GuestsService } from './guests.service';

@Module({
  controllers: [GuestsController, CorporateAccountsController],
  providers: [GuestsService, CorporateAccountsService],
  exports: [GuestsService],
})
export class GuestsModule {}
