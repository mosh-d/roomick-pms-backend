import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { ReportsModule } from '../reports/reports.module';
import { RateResolverModule } from '../rate-resolver/rate-resolver.module';
import { RevenueManagementController } from './revenue-management.controller';
import { RestrictionsService } from './restrictions.service';
import { DemandForecastService } from './demand-forecast.service';
import { RateRecommendationsService } from './rate-recommendations.service';
import { CompSetService } from './comp-set.service';

@Module({
  imports: [PropertyModule, ReportsModule, RateResolverModule],
  controllers: [RevenueManagementController],
  providers: [RestrictionsService, DemandForecastService, RateRecommendationsService, CompSetService],
  exports: [RestrictionsService],
})
export class RevenueManagementModule {}
