import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { TaxesModule } from '../taxes/taxes.module';
import { RateResolverController } from './rate-resolver.controller';
import { RateResolverService } from './rate-resolver.service';

@Module({
  imports: [PropertyModule, TaxesModule],
  controllers: [RateResolverController],
  providers: [RateResolverService],
  exports: [RateResolverService],
})
export class RateResolverModule {}
