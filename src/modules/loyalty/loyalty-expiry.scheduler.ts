import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LoyaltyService } from './loyalty.service';

/** Takes off loyalty points that have lapsed unspent, once a night. */
@Injectable()
export class LoyaltyExpiryScheduler {
  private readonly logger = new Logger(LoyaltyExpiryScheduler.name);

  constructor(private readonly loyaltyService: LoyaltyService) {}

  @Cron('20 3 * * *')
  async sweep(): Promise<void> {
    try {
      const lapsed = await this.loyaltyService.expireLapsedPoints();
      if (lapsed > 0) this.logger.log(`${lapsed} loyalty point(s) lapsed unspent`);
    } catch (error) {
      this.logger.error('Loyalty points expiry sweep failed', error);
    }
  }
}
