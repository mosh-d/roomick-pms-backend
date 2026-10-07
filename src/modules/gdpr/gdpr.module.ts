import { Module } from '@nestjs/common';
import { GuestsModule } from '../guests/guests.module';
import { GdprController } from './gdpr.controller';
import { GdprService } from './gdpr.service';
import { RetentionScheduler } from './retention.scheduler';
import { RetentionService } from './retention.service';

@Module({
  imports: [GuestsModule],
  controllers: [GdprController],
  providers: [GdprService, RetentionService, RetentionScheduler],
})
export class GdprModule {}
