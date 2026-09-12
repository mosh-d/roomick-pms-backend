import { Module } from '@nestjs/common';
import { CommsDispatcherService } from './comms-dispatcher.service';
import { CommsLogController } from './comms-log.controller';
import { CommsLogService } from './comms-log.service';

@Module({
  controllers: [CommsLogController],
  providers: [CommsLogService, CommsDispatcherService],
  exports: [CommsLogService, CommsDispatcherService],
})
export class CommsLogModule {}
