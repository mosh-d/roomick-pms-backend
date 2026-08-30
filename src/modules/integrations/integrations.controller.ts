import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CreateApiKeyDto, CreateWebhookDto } from './dto/integrations.dto';
import { IntegrationsService, ApiKeySummary, CreatedApiKey, WebhookSummary, CreatedWebhook } from './integrations.service';

@ApiTags('integrations')
@ApiBearerAuth()
@Controller()
@Roles(SystemRole.Owner)
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Post('api-keys')
  @ApiOperation({ summary: 'Integrations & APIs — generate a new API key; the raw key is returned exactly once' })
  createApiKey(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: CreateApiKeyDto): Promise<CreatedApiKey> {
    return this.integrationsService.createApiKey(tenantId, dto.name, user.sub);
  }

  @Get('api-keys')
  @ApiOperation({ summary: 'List API keys — metadata only, the raw key is never retrievable again' })
  listApiKeys(@CurrentTenant() tenantId: string): Promise<ApiKeySummary[]> {
    return this.integrationsService.listApiKeys(tenantId);
  }

  @Delete('api-keys/:keyId')
  @ApiOperation({ summary: 'Revoke an API key' })
  revokeApiKey(@CurrentTenant() tenantId: string, @Param('keyId', ParseUUIDPipe) keyId: string): Promise<ApiKeySummary> {
    return this.integrationsService.revokeApiKey(tenantId, keyId);
  }

  @Post('webhooks')
  @ApiOperation({ summary: 'Integrations & APIs — subscribe an external system to PMS events; the signing secret is returned exactly once' })
  createWebhook(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: CreateWebhookDto): Promise<CreatedWebhook> {
    return this.integrationsService.createWebhook(tenantId, dto, user.sub);
  }

  @Get('webhooks')
  @ApiOperation({ summary: 'List webhook subscriptions — the signing secret is never returned again' })
  listWebhooks(@CurrentTenant() tenantId: string): Promise<WebhookSummary[]> {
    return this.integrationsService.listWebhooks(tenantId);
  }

  @Delete('webhooks/:webhookId')
  @ApiOperation({ summary: 'Deactivate a webhook subscription (never hard-deleted)' })
  deactivateWebhook(@CurrentTenant() tenantId: string, @Param('webhookId', ParseUUIDPipe) webhookId: string): Promise<WebhookSummary> {
    return this.integrationsService.deactivateWebhook(tenantId, webhookId);
  }
}
