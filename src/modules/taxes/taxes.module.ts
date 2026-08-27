import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { TaxesController } from './taxes.controller';
import { TaxesService } from './taxes.service';

@Module({
  imports: [PropertyModule],
  controllers: [TaxesController],
  providers: [TaxesService],
  exports: [TaxesService],
})
export class TaxesModule {}
