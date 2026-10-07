import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { CustomReportsController } from './custom-reports.controller';
import { CustomReportsService } from './custom-reports.service';

@Module({
  imports: [PropertyModule],
  controllers: [ReportsController, CustomReportsController],
  providers: [ReportsService, CustomReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
