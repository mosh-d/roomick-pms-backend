import { Module } from '@nestjs/common';
import { GuestsModule } from '../guests/guests.module';
import { GdprController } from './gdpr.controller';
import { GdprService } from './gdpr.service';

@Module({
  imports: [GuestsModule],
  controllers: [GdprController],
  providers: [GdprService],
})
export class GdprModule {}
