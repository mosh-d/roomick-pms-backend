import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { RateResolverModule } from '../rate-resolver/rate-resolver.module';
import { RevenueManagementController } from './revenue-management.controller';
import { RestrictionsService } from './restrictions.service';
import { DemandForecastService } from './demand-forecast.service';
import { RateRecommendationsService } from './rate-recommendations.service';

@Module({
  imports: [ReportsModule, RateResolverModule],
  controllers: [RevenueManagementController],
  providers: [RestrictionsService, DemandForecastService, RateRecommendationsService],
  exports: [RestrictionsService],
})
export class RevenueManagementModule {}
