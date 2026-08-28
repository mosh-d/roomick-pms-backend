import { Module } from '@nestjs/common';
import { CommsLogController } from './comms-log.controller';
import { CommsLogService } from './comms-log.service';

@Module({
  controllers: [CommsLogController],
  providers: [CommsLogService],
  exports: [CommsLogService],
})
export class CommsLogModule {}
