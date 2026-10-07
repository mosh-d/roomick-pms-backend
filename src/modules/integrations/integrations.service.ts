import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { hashApiKey } from '../../common/auth/api-key-auth.service';
import { ErrorCode } from '../../common/errors/error-codes';
import { PERMISSION_MODULES } from '../../common/permissions/permission-catalogue';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CreateApiKeyDto, CreateWebhookDto, UpdateApiKeyDto, UpdateWebhookDto } from './dto/integrations.dto';
import { DELIVERY_SELECT, DeliveryView, toDeliveryView } from './webhook-dispatcher.service';
import { WEBHOOK_EVENTS } from './webhook-events';
import { webhookUrlProblem } from './webhook-http';

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  branch: { id: string; name: string } | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface CreatedApiKey extends ApiKeySummary {
  /** Shown exactly once — never retrievable again. */
  rawKey: string;
}

export interface WebhookSummary {
  id: string;
  url: string;
  eventTypes: string[];
  branch: { id: string; name: string } | null;
  isActive: boolean;
  createdAt: Date;
  /** Waiting to be sent or retried, and given up on in the last week — what tells the owner a receiver is in trouble. */
  pending: number;
  failedThisWeek: number;
  lastDeliveredAt: Date | null;
}

export interface CreatedWebhook extends WebhookSummary {
  /** Shown exactly once — signs every delivery. */
  secret: string;
}

const API_KEY_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  scopes: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
  branch: { select: { id: true, name: true } },
} satisfies Prisma.ApiKeySelect;

const WEBHOOK_SELECT = {
  id: true,
  url: true,
  eventTypes: true,
  isActive: true,
  createdAt: true,
  branch: { select: { id: true, name: true } },
} satisfies Prisma.WebhookSelect;

const production = () => process.env.NODE_ENV === 'production';

/**
 * Integrations & APIs: the API keys another system reads with, and the
 * webhooks it's told about changes through.
 *
 * A key is read-only and limited to the modules it's given (and optionally
 * one branch); `JwtAuthGuard` signs a request in with it and `RolesGuard`
 * holds it to that. A webhook names the events it wants; they're queued by
 * `WebhookEventsService` as changes happen and sent by
 * `WebhookDispatcherService`, signed with the webhook's secret.
 *
 * Neither secret is ever stored readable — the key only as a hash — and
 * neither is written to the audit trail. Payment Gateway (the reference's
 * third card) stays unbuilt: no payment processor is connected to configure.
 */
@Injectable()
export class IntegrationsService {
  constructor(private readonly prisma: PrismaService) {}

  // --- API Keys -------------------------------------------------------------

  /** What a key can be given: the permission modules, read only. */
  scopeCatalogue() {
    return PERMISSION_MODULES.map(({ key, label, description }) => ({ key, label, description }));
  }

  async createApiKey(tenantId: string, dto: CreateApiKeyDto, actorId: string): Promise<CreatedApiKey> {
    const rawKey = `rk_${randomBytes(24).toString('hex')}`;
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (dto.branchId) await this.assertBranch(tx, dto.branchId);
      const created = await tx.apiKey.create({
        data: {
          tenantId,
          name: dto.name.trim(),
          keyPrefix: rawKey.slice(0, 10),
          keyHash: hashApiKey(rawKey),
          scopes: [...new Set(dto.scopes)],
          branchId: dto.branchId ?? null,
          createdBy: actorId,
        },
        select: API_KEY_SELECT,
      });
      await this.audit(tx, tenantId, actorId, 'api_key.created', 'api_key', created.id, { name: created.name, scopes: created.scopes, branchId: dto.branchId ?? null });
      return { ...created, rawKey };
    });
  }

  async listApiKeys(tenantId: string): Promise<ApiKeySummary[]> {
    return this.prisma.withTenant(tenantId, (tx) => tx.apiKey.findMany({ orderBy: { createdAt: 'desc' }, select: API_KEY_SELECT }));
  }

  /** A key's name, what it can read, or its branch — the key itself doesn't change, so nothing using it needs updating. */
  async updateApiKey(tenantId: string, keyId: string, dto: UpdateApiKeyDto, actorId: string): Promise<ApiKeySummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const key = await tx.apiKey.findFirst({ where: { id: keyId } });
      if (!key) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'API key not found' });
      if (key.revokedAt) throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'This key is revoked — make a new one' });
      if (dto.branchId) await this.assertBranch(tx, dto.branchId);
      const updated = await tx.apiKey.update({
        where: { id: keyId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.scopes !== undefined ? { scopes: [...new Set(dto.scopes)] } : {}),
          ...(dto.branchId !== undefined ? { branchId: dto.branchId } : {}),
        },
        select: API_KEY_SELECT,
      });
      await this.audit(tx, tenantId, actorId, 'api_key.updated', 'api_key', keyId, {
        before: { name: key.name, scopes: key.scopes, branchId: key.branchId },
        after: { name: updated.name, scopes: updated.scopes, branchId: updated.branch?.id ?? null },
      });
      return updated;
    });
  }

  async revokeApiKey(tenantId: string, keyId: string, actorId: string): Promise<ApiKeySummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const key = await tx.apiKey.findFirst({ where: { id: keyId } });
      if (!key) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'API key not found' });
      if (key.revokedAt) return tx.apiKey.findFirstOrThrow({ where: { id: keyId }, select: API_KEY_SELECT });
      const updated = await tx.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() }, select: API_KEY_SELECT });
      await this.audit(tx, tenantId, actorId, 'api_key.revoked', 'api_key', keyId, { name: key.name });
      return updated;
    });
  }

  // --- Webhooks ---------------------------------------------------------------

  eventCatalogue() {
    return WEBHOOK_EVENTS.map(({ type, label, description }) => ({ type, label, description }));
  }

  async createWebhook(tenantId: string, dto: CreateWebhookDto, actorId: string): Promise<CreatedWebhook> {
    this.assertUsableUrl(dto.url);
    const secret = randomBytes(24).toString('hex');
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (dto.branchId) await this.assertBranch(tx, dto.branchId);
      const created = await tx.webhook.create({
        data: { tenantId, url: dto.url, eventTypes: [...new Set(dto.eventTypes)], secret, branchId: dto.branchId ?? null, createdBy: actorId },
        select: WEBHOOK_SELECT,
      });
      await this.audit(tx, tenantId, actorId, 'webhook.created', 'webhook', created.id, { url: created.url, eventTypes: created.eventTypes, branchId: dto.branchId ?? null });
      return { ...created, pending: 0, failedThisWeek: 0, lastDeliveredAt: null, secret };
    });
  }

  async listWebhooks(tenantId: string): Promise<WebhookSummary[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const webhooks = await tx.webhook.findMany({ orderBy: { createdAt: 'desc' }, select: WEBHOOK_SELECT });
      if (webhooks.length === 0) return [];
      const ids = webhooks.map((webhook) => webhook.id);
      const weekAgo = new Date(Date.now() - 7 * 86_400_000);
      const [pending, failed, delivered] = await Promise.all([
        tx.webhookDelivery.groupBy({ by: ['webhookId'], where: { webhookId: { in: ids }, status: 'pending' }, _count: { _all: true } }),
        tx.webhookDelivery.groupBy({ by: ['webhookId'], where: { webhookId: { in: ids }, status: 'failed', createdAt: { gte: weekAgo } }, _count: { _all: true } }),
        tx.webhookDelivery.groupBy({ by: ['webhookId'], where: { webhookId: { in: ids }, status: 'delivered' }, _max: { deliveredAt: true } }),
      ]);
      const count = (rows: Array<{ webhookId: string; _count: { _all: number } }>, id: string) => rows.find((row) => row.webhookId === id)?._count._all ?? 0;
      return webhooks.map((webhook) => ({
        ...webhook,
        pending: count(pending, webhook.id),
        failedThisWeek: count(failed, webhook.id),
        lastDeliveredAt: delivered.find((row) => row.webhookId === webhook.id)?._max.deliveredAt ?? null,
      }));
    });
  }

  /**
   * Change where a webhook sends, what it listens for, its branch — or switch
   * it off or on. Switching off drops what was waiting to be sent: a receiver
   * switched back on next week shouldn't get last week's news.
   */
  async updateWebhook(tenantId: string, webhookId: string, dto: UpdateWebhookDto, actorId: string): Promise<WebhookSummary> {
    if (dto.url !== undefined) this.assertUsableUrl(dto.url);
    await this.prisma.withTenant(tenantId, async (tx) => {
      const webhook = await tx.webhook.findFirst({ where: { id: webhookId } });
      if (!webhook) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Webhook not found' });
      if (dto.branchId) await this.assertBranch(tx, dto.branchId);
      if (dto.isActive === true && dto.eventTypes === undefined && webhook.eventTypes.length === 0) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Choose at least one event before switching this webhook on' });
      }
      const updated = await tx.webhook.update({
        where: { id: webhookId },
        data: {
          ...(dto.url !== undefined ? { url: dto.url } : {}),
          ...(dto.eventTypes !== undefined ? { eventTypes: [...new Set(dto.eventTypes)] } : {}),
          ...(dto.branchId !== undefined ? { branchId: dto.branchId } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      if (webhook.isActive && !updated.isActive) await this.dropWaiting(tx, webhookId);
      await this.audit(tx, tenantId, actorId, 'webhook.updated', 'webhook', webhookId, {
        before: { url: webhook.url, eventTypes: webhook.eventTypes, branchId: webhook.branchId, isActive: webhook.isActive },
        after: { url: updated.url, eventTypes: updated.eventTypes, branchId: updated.branchId, isActive: updated.isActive },
      });
    });
    return (await this.listWebhooks(tenantId)).find((webhook) => webhook.id === webhookId)!;
  }

  /** Switched off, never deleted — its delivery history stays readable. */
  async deactivateWebhook(tenantId: string, webhookId: string, actorId: string): Promise<WebhookSummary> {
    return this.updateWebhook(tenantId, webhookId, { isActive: false }, actorId);
  }

  async listDeliveries(tenantId: string, webhookId: string): Promise<DeliveryView[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const webhook = await tx.webhook.findFirst({ where: { id: webhookId }, select: { id: true } });
      if (!webhook) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Webhook not found' });
      const rows = await tx.webhookDelivery.findMany({ where: { webhookId }, orderBy: { createdAt: 'desc' }, take: 50, select: DELIVERY_SELECT });
      return rows.map(toDeliveryView);
    });
  }

  // --- Helpers ----------------------------------------------------------------

  private assertUsableUrl(url: string): void {
    const problem = webhookUrlProblem(url, production());
    if (problem) throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: problem });
  }

  private async assertBranch(tx: TenantTx, branchId: string): Promise<void> {
    const branch = await tx.branch.findFirst({ where: { id: branchId, deletedAt: null }, select: { id: true } });
    if (!branch) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Branch not found' });
  }

  private async dropWaiting(tx: TenantTx, webhookId: string): Promise<void> {
    await tx.webhookDelivery.updateMany({
      where: { webhookId, status: 'pending' },
      data: { status: 'failed', lastError: 'The webhook was switched off before this was sent', lockedUntil: null },
    });
  }

  /** Never the key or the secret — only what was set. */
  private async audit(tx: TenantTx, tenantId: string, userId: string, action: string, entityType: string, entityId: string, after: Prisma.InputJsonObject): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, userId, action, entityType, entityId, after } });
  }
}
