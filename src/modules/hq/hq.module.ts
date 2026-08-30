import { Module } from '@nestjs/common';
import { FoliosModule } from '../folios/folios.module';
import { ReportsModule } from '../reports/reports.module';
import { HqController } from './hq.controller';
import { HqService } from './hq.service';

@Module({
  imports: [FoliosModule, ReportsModule],
  controllers: [HqController],
  providers: [HqService],
})
export class HqModule {}
