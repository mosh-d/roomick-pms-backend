import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { CampaignSchedulerService } from './campaign-scheduler.service';
import { MarketingController, PublicMarketingController } from './marketing.controller';
import { MarketingService } from './marketing.service';

/**
 * Month 11's Email Campaign Builder. Delivery is not in here on purpose —
 * campaigns write to the Comms Log outbox and `CommsDispatcherService`
 * sends them, so this module only needs the mail transport for test sends
 * (provided globally by CommonModule).
 */
@Module({
  imports: [PropertyModule],
  controllers: [MarketingController, PublicMarketingController],
  providers: [MarketingService, CampaignSchedulerService],
  exports: [MarketingService],
})
export class MarketingModule {}
