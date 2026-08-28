import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BackupsService } from './backups.service';

/** Kept separate from `BackupsService` — same reasoning as `NightAuditScheduler`: the service stays a plain, directly-callable unit, cron is layered on top rather than baked in. 2 AM, not midnight, so it doesn't compete with `TenantsService`'s own midnight demo-tenant sweep. */
@Injectable()
export class BackupsScheduler {
  private readonly logger = new Logger(BackupsScheduler.name);

  constructor(private readonly backupsService: BackupsService) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async nightlyBackup(): Promise<void> {
    try {
      await this.backupsService.runBackupForAllTenants();
    } catch (error) {
      this.logger.error('Nightly backup sweep failed', error);
    }
  }

  /** "Restore test procedure (documented + run monthly)" — noon on the 1st, clear of the nightly 2 AM backup and midnight demo-sweep crons. */
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_NOON)
  async monthlyRestoreDrill(): Promise<void> {
    try {
      await this.backupsService.runRestoreDrillForAllTenants();
    } catch (error) {
      this.logger.error('Monthly restore drill sweep failed', error);
    }
  }
}
