import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CreateApiKeyDto, CreateWebhookDto, UpdateApiKeyDto, UpdateWebhookDto } from './dto/integrations.dto';
import { ApiKeySummary, CreatedApiKey, CreatedWebhook, IntegrationsService, WebhookSummary } from './integrations.service';
import { DeliveryView, WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * Owner only, and out of reach of custom roles and API keys alike: there's no
 * `@Permission` module for integrations, by design.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller()
@Roles(SystemRole.Owner)
export class IntegrationsController {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly dispatcher: WebhookDispatcherService,
  ) {}

  // --- API keys ---------------------------------------------------------------

  @Get('api-keys/scopes')
  @ApiOperation({ summary: 'What an API key can be given to read — the permission modules' })
  apiKeyScopes(): ReturnType<IntegrationsService['scopeCatalogue']> {
    return this.integrationsService.scopeCatalogue();
  }

  @Post('api-keys')
  @ApiOperation({ summary: 'Make an API key that reads what it is given (and optionally one branch); the key is returned exactly once' })
  createApiKey(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: CreateApiKeyDto): Promise<CreatedApiKey> {
    return this.integrationsService.createApiKey(tenantId, dto, user.sub);
  }

  @Get('api-keys')
  @ApiOperation({ summary: 'API keys — what each can read, never the key itself' })
  listApiKeys(@CurrentTenant() tenantId: string): Promise<ApiKeySummary[]> {
    return this.integrationsService.listApiKeys(tenantId);
  }

  @Patch('api-keys/:keyId')
  @ApiOperation({ summary: 'Rename a key, or change what it can read or its branch' })
  updateApiKey(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('keyId', ParseUUIDPipe) keyId: string,
    @Body() dto: UpdateApiKeyDto,
  ): Promise<ApiKeySummary> {
    return this.integrationsService.updateApiKey(tenantId, keyId, dto, user.sub);
  }

  @Delete('api-keys/:keyId')
  @ApiOperation({ summary: 'Revoke an API key — it stops working at once' })
  revokeApiKey(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('keyId', ParseUUIDPipe) keyId: string): Promise<ApiKeySummary> {
    return this.integrationsService.revokeApiKey(tenantId, keyId, user.sub);
  }

  // --- Webhooks ---------------------------------------------------------------

  @Get('webhooks/events')
  @ApiOperation({ summary: 'The events a webhook can listen for' })
  webhookEvents(): ReturnType<IntegrationsService['eventCatalogue']> {
    return this.integrationsService.eventCatalogue();
  }

  @Post('webhooks')
  @ApiOperation({ summary: 'Tell another system about events here; the signing secret is returned exactly once' })
  createWebhook(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: CreateWebhookDto): Promise<CreatedWebhook> {
    return this.integrationsService.createWebhook(tenantId, dto, user.sub);
  }

  @Get('webhooks')
  @ApiOperation({ summary: 'Webhooks, with what is waiting and what failed this week — the secret is never returned again' })
  listWebhooks(@CurrentTenant() tenantId: string): Promise<WebhookSummary[]> {
    return this.integrationsService.listWebhooks(tenantId);
  }

  @Patch('webhooks/:webhookId')
  @ApiOperation({ summary: 'Change a webhook’s address, events or branch, or switch it off or on' })
  updateWebhook(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('webhookId', ParseUUIDPipe) webhookId: string,
    @Body() dto: UpdateWebhookDto,
  ): Promise<WebhookSummary> {
    return this.integrationsService.updateWebhook(tenantId, webhookId, dto, user.sub);
  }

  @Delete('webhooks/:webhookId')
  @ApiOperation({ summary: 'Switch a webhook off (never deleted — its deliveries stay readable)' })
  deactivateWebhook(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('webhookId', ParseUUIDPipe) webhookId: string): Promise<WebhookSummary> {
    return this.integrationsService.deactivateWebhook(tenantId, webhookId, user.sub);
  }

  @Post('webhooks/:webhookId/test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a test event now and say whether it arrived' })
  testWebhook(@CurrentTenant() tenantId: string, @Param('webhookId', ParseUUIDPipe) webhookId: string): Promise<DeliveryView> {
    return this.dispatcher.sendTest(tenantId, webhookId);
  }

  @Get('webhooks/:webhookId/deliveries')
  @ApiOperation({ summary: 'The last 50 deliveries to a webhook, newest first' })
  listDeliveries(@CurrentTenant() tenantId: string, @Param('webhookId', ParseUUIDPipe) webhookId: string): Promise<DeliveryView[]> {
    return this.integrationsService.listDeliveries(tenantId, webhookId);
  }

  @Post('webhook-deliveries/:deliveryId/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Try a delivery again now — one waiting on a retry, or one given up on' })
  retryDelivery(@CurrentTenant() tenantId: string, @Param('deliveryId', ParseUUIDPipe) deliveryId: string): Promise<DeliveryView> {
    return this.dispatcher.retryNow(tenantId, deliveryId);
  }
}
