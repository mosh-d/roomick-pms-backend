import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { WebhookDispatcherService, WebhookSender } from './webhook-dispatcher.service';
import { WebhookEventsService } from './webhook-events.service';

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, WebhookDispatcherService, WebhookSender, WebhookEventsService],
  // Reservations and bills raise events as they change.
  exports: [WebhookEventsService],
})
export class IntegrationsModule {}
