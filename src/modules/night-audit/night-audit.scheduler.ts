import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NightAuditService } from './night-audit.service';

/**
 * Kept separate from `NightAuditService` so the service stays a plain,
 * directly-callable unit (the manual trigger and the tests both use it
 * without a scheduler in the way) — the same split the in-house PMS uses
 * between its `TasksService` cron and its audit service.
 *
 * Hourly, not once-a-day-at-3am: branches carry their own IANA timezones,
 * so a single fixed-time cron would fire at the wrong local hour for most
 * of them. Each pass asks per branch whether its own local clock has
 * passed the audit hour — see `runScheduledSweep`.
 */
@Injectable()
export class NightAuditScheduler {
  private readonly logger = new Logger(NightAuditScheduler.name);

  constructor(private readonly nightAuditService: NightAuditService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<void> {
    try {
      await this.nightAuditService.runScheduledSweep();
    } catch (error) {
      this.logger.error('Night audit sweep failed', error);
    }
  }
}
