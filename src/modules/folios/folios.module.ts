import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { PropertyModule } from '../property/property.module';
import { TaxesModule } from '../taxes/taxes.module';
import { FoliosController } from './folios.controller';
import { FoliosService } from './folios.service';
import { ExchangeRatesService } from './exchange-rates.service';
import { InvoicesService } from './invoices.service';
import { MoneyController } from './money.controller';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

@Module({
  imports: [PropertyModule, TaxesModule, IntegrationsModule],
  controllers: [FoliosController, RefundsController, MoneyController],
  providers: [FoliosService, RefundsService, InvoicesService, ExchangeRatesService],
  exports: [FoliosService, RefundsService, InvoicesService],
})
export class FoliosModule {}
