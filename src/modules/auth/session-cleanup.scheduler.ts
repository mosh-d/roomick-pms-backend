import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuthService } from './auth.service';

/** Once a day, clears out sessions that ended or expired over a week ago — see `AuthService.pruneEndedSessions`. */
@Injectable()
export class SessionCleanupScheduler {
  private readonly logger = new Logger(SessionCleanupScheduler.name);

  constructor(private readonly authService: AuthService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async prune(): Promise<void> {
    try {
      const pruned = await this.authService.pruneEndedSessions();
      if (pruned > 0) this.logger.log(`Pruned ${pruned} ended sessions`);
    } catch (error) {
      this.logger.error('Session cleanup failed', error);
    }
  }
}
