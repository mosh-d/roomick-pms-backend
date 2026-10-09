import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RoomsService } from './rooms.service';

/**
 * Brings held rooms back into service on their release date. Hourly, like the
 * night audit's sweep: each branch keeps its own clock, so a single fixed-time
 * run would be the wrong local hour for most of them.
 */
@Injectable()
export class RoomHoldsScheduler {
  private readonly logger = new Logger(RoomHoldsScheduler.name);

  constructor(private readonly roomsService: RoomsService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<void> {
    try {
      const released = await this.roomsService.releaseDueHolds();
      if (released > 0) this.logger.log(`${released} held room(s) back in service on their release date`);
    } catch (error) {
      this.logger.error('Room hold release sweep failed', error);
    }
  }
}
