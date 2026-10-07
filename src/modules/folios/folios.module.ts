import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { TaxesModule } from '../taxes/taxes.module';
import { FoliosController } from './folios.controller';
import { FoliosService } from './folios.service';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

@Module({
  imports: [PropertyModule, TaxesModule],
  controllers: [FoliosController, RefundsController],
  providers: [FoliosService, RefundsService],
  exports: [FoliosService],
})
export class FoliosModule {}
