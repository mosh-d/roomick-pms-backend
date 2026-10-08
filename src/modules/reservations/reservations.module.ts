import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { TaxesModule } from '../taxes/taxes.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PropertyModule } from '../property/property.module';
import { GuestsModule } from '../guests/guests.module';
import { FoliosModule } from '../folios/folios.module';
import { HousekeepingModule } from '../housekeeping/housekeeping.module';
import { RateResolverModule } from '../rate-resolver/rate-resolver.module';
import { RegistrationCardsModule } from '../registration-cards/registration-cards.module';
import { CommsLogModule } from '../comms-log/comms-log.module';
import { RevenueManagementModule } from '../revenue-management/revenue-management.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [PropertyModule, GuestsModule, FoliosModule, HousekeepingModule, RateResolverModule, RegistrationCardsModule, CommsLogModule, RevenueManagementModule, LoyaltyModule, IntegrationsModule, TaxesModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
