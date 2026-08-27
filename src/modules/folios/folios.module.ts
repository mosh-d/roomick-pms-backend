import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { TaxesModule } from '../taxes/taxes.module';
import { FoliosController } from './folios.controller';
import { FoliosService } from './folios.service';

@Module({
  imports: [PropertyModule, TaxesModule],
  controllers: [FoliosController],
  providers: [FoliosService],
  exports: [FoliosService],
})
export class FoliosModule {}
