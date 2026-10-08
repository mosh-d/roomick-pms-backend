import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RetentionService } from './retention.service';

/** Every night, removes the registration-card details and ID documents past each tenant's retention period — see `RetentionService`. */
@Injectable()
export class RetentionScheduler {
  private readonly logger = new Logger(RetentionScheduler.name);

  constructor(private readonly retentionService: RetentionService) {}

  // 04:30, after the session clean-up at 04:00 and the backups at 02:00 — the
  // night's backup still holds what's removed, for as long as backups are kept.
  @Cron('30 4 * * *')
  async purge(): Promise<void> {
    try {
      const run = await this.retentionService.purgeAll();
      if (run.registrationCards > 0 || run.idDocuments > 0) {
        this.logger.log(`Retention: removed ${run.registrationCards} registration card(s) and ${run.idDocuments} ID document(s)`);
      }
      const quotes = await this.retentionService.pruneRateQuotes();
      if (quotes > 0) this.logger.log(`Retention: pruned ${quotes} rate quote(s) older than 90 days that never became a booking`);
    } catch (error) {
      this.logger.error('Retention run failed', error);
    }
  }
}
