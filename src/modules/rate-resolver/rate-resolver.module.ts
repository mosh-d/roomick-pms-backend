import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { TaxesModule } from '../taxes/taxes.module';
import { RateResolverController } from './rate-resolver.controller';
import { RateResolverService } from './rate-resolver.service';
import { PackagesService } from './packages.service';

@Module({
  imports: [PropertyModule, TaxesModule],
  controllers: [RateResolverController],
  providers: [RateResolverService, PackagesService],
  exports: [RateResolverService, PackagesService],
})
export class RateResolverModule {}
