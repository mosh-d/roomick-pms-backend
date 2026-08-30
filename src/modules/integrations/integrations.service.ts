import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateWebhookDto } from './dto/integrations.dto';

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
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
  isActive: boolean;
  createdAt: Date;
}

export interface CreatedWebhook extends WebhookSummary {
  /** Shown exactly once — used to sign a delivered payload, if/when delivery is ever wired up. */
  secret: string;
}

/**
 * Integrations & APIs' own "API Keys" and "Webhooks" cards — real, CRUD-
 * complete, and honestly incomplete in the same specific way: neither one
 * DOES anything to the rest of this app yet.
 *
 * `ApiKey` rows are generated and stored (SHA-256 hash only, never the raw
 * key) but no route in this codebase accepts one as an alternative to the
 * existing JWT — `JwtAuthGuard`/`TenantGuard`/`RolesGuard` are the only
 * auth path today. Building a second, parallel, self-rolled authentication
 * mechanism just to "prove" this card is a materially different, far
 * riskier scope than CRUD over a new table — the same class of decision
 * that kept GDPR erasure human-triggered and Feature Flags' resolution
 * unenforced elsewhere in this sequence. `verifyApiKey` exists, tested, and
 * ready for a future pass that actually wires it into a guard.
 *
 * `Webhook` rows are the subscription definitions only — no delivery
 * infrastructure (matching a subscription against a real event, POSTing,
 * retry/backoff) exists. Real delivery would need a single trigger point
 * every mutating action passes through; this app's own audit trail already
 * proves such a point doesn't cleanly exist yet (each service module hand-
 * rolls its own private `audit()` — see this session's own notes on why
 * that's pre-existing debt, not something to fix inside this pass).
 *
 * Payment Gateway (the reference's third card) isn't represented here at
 * all: this app has no real payment-processor integration anywhere to
 * configure, and a form that stores gateway "credentials" nothing ever
 * reads would be actively misleading, not an honest partial feature.
 */
@Injectable()
export class IntegrationsService {
  constructor(private readonly prisma: PrismaService) {}

  // --- API Keys -------------------------------------------------------------

  async createApiKey(tenantId: string, name: string, actorId: string): Promise<CreatedApiKey> {
    const rawKey = `rk_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 10);

    const created = await this.prisma.withTenant(tenantId, (tx) =>
      tx.apiKey.create({ data: { tenantId, name, keyPrefix, keyHash, createdBy: actorId } }),
    );

    return {
      id: created.id,
      name: created.name,
      keyPrefix: created.keyPrefix,
      createdAt: created.createdAt,
      lastUsedAt: null,
      revokedAt: null,
      rawKey,
    };
  }

  async listApiKeys(tenantId: string): Promise<ApiKeySummary[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.apiKey.findMany({
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, keyPrefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
      }),
    );
  }

  async revokeApiKey(tenantId: string, keyId: string): Promise<ApiKeySummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const key = await tx.apiKey.findFirst({ where: { id: keyId } });
      if (!key) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'API key not found' });
      const updated = await tx.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
      return { id: updated.id, name: updated.name, keyPrefix: updated.keyPrefix, createdAt: updated.createdAt, lastUsedAt: updated.lastUsedAt, revokedAt: updated.revokedAt };
    });
  }

  /** Unused by any route today — see this class's own header comment. Kept real and tested so a future pass can wire it into a guard without redesigning the hashing/lookup itself. */
  async verifyApiKey(tenantId: string, rawKey: string): Promise<boolean> {
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    return this.prisma.withTenant(tenantId, async (tx) => {
      const key = await tx.apiKey.findFirst({ where: { keyHash, revokedAt: null } });
      if (!key) return false;
      await tx.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
      return true;
    });
  }

  // --- Webhooks ---------------------------------------------------------------

  async createWebhook(tenantId: string, dto: CreateWebhookDto, actorId: string): Promise<CreatedWebhook> {
    const secret = randomBytes(24).toString('hex');
    const created = await this.prisma.withTenant(tenantId, (tx) =>
      tx.webhook.create({ data: { tenantId, url: dto.url, eventTypes: dto.eventTypes, secret, createdBy: actorId } }),
    );
    return { id: created.id, url: created.url, eventTypes: created.eventTypes, isActive: created.isActive, createdAt: created.createdAt, secret };
  }

  async listWebhooks(tenantId: string): Promise<WebhookSummary[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.webhook.findMany({
        orderBy: { createdAt: 'desc' },
        select: { id: true, url: true, eventTypes: true, isActive: true, createdAt: true },
      }),
    );
  }

  /** Deactivates, never deletes — same "never delete configuration, just stop honoring it" discipline `FeatureFlag`'s own schema comment already established. */
  async deactivateWebhook(tenantId: string, webhookId: string): Promise<WebhookSummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const webhook = await tx.webhook.findFirst({ where: { id: webhookId } });
      if (!webhook) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Webhook not found' });
      const updated = await tx.webhook.update({ where: { id: webhookId }, data: { isActive: false } });
      return { id: updated.id, url: updated.url, eventTypes: updated.eventTypes, isActive: updated.isActive, createdAt: updated.createdAt };
    });
  }
}
