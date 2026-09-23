import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { AccountingExportService } from './accounting-export.service';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { ReviewRequestsService } from './review-requests.service';

/**
 * Month 11's Integrations Marketplace: the catalogue, the enable/configure/
 * disable lifecycle, and the connectors that really work today — the
 * QuickBooks Online and Xero journal exports and post-stay review requests.
 * Review requests are delivered by the comms outbox, not from here.
 */
@Module({
  imports: [PropertyModule],
  controllers: [MarketplaceController],
  providers: [MarketplaceService, AccountingExportService, ReviewRequestsService],
})
export class MarketplaceModule {}
