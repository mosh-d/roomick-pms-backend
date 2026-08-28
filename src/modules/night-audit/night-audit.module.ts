import { Module } from '@nestjs/common';
import { PropertyModule } from '../property/property.module';
import { FoliosModule } from '../folios/folios.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { NightAuditController } from './night-audit.controller';
import { NightAuditScheduler } from './night-audit.scheduler';
import { NightAuditService } from './night-audit.service';

@Module({
  imports: [PropertyModule, FoliosModule, ReservationsModule],
  controllers: [NightAuditController],
  providers: [NightAuditService, NightAuditScheduler],
  exports: [NightAuditService],
})
export class NightAuditModule {}
