import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { FoliosModule } from '../folios/folios.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

@Module({
  imports: [PropertyModule, FoliosModule],
  controllers: [AlertsController],
  providers: [AlertsService],
})
export class AlertsModule {}
