import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { Prisma, WebhookDeliveryStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { TEST_EVENT_TYPE, WebhookPayload } from './webhook-events';
import { postWebhook, signatureHeader, WebhookPostResult } from './webhook-http';

/** Tries before a delivery is given up on. */
export const MAX_ATTEMPTS = 8;
/** The wait after the 1st, 2nd … 7th failed try — about a day from first try to last. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];
/** How long a dispatcher holds a delivery it's sending, so another server (or a "Retry" click) can't send it at the same time. */
const CLAIM_MS = 60_000;
const BATCH_SIZE = 25;
/** Sends at once per tenant pass — one slow receiver mustn't hold up the rest. */
const CONCURRENCY = 4;
const TIMEOUT_MS = 10_000;
/** After an event is queued, how long its tenant is looked at every couple of seconds — long enough to outlast the transaction that queued it. */
const KICK_WINDOW_MS = 20_000;
/** Deliveries carry guest details; they're kept long enough to investigate a failure, not forever. */
const RETENTION_DAYS = 30;

/** Sends one delivery. A class of its own so tests can stand in for the network. */
@Injectable()
export class WebhookSender {
  send(url: string, body: string, headers: Record<string, string>): Promise<WebhookPostResult> {
    // Private addresses only in development, where a receiver on localhost is how an integration is tested.
    return postWebhook(url, body, headers, { allowPrivate: process.env.NODE_ENV !== 'production', timeoutMs: TIMEOUT_MS });
  }
}

/** One delivery, as the Integrations page shows it. */
export interface DeliveryView {
  id: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

export const DELIVERY_SELECT = {
  id: true,
  eventId: true,
  eventType: true,
  status: true,
  attempts: true,
  responseStatus: true,
  lastError: true,
  nextAttemptAt: true,
  lastAttemptAt: true,
  deliveredAt: true,
  createdAt: true,
} satisfies Prisma.WebhookDeliverySelect;

export function toDeliveryView(row: Prisma.WebhookDeliveryGetPayload<{ select: typeof DELIVERY_SELECT }>): DeliveryView {
  return { ...row, nextAttemptAt: row.status === 'pending' ? row.nextAttemptAt : null };
}

export interface DispatchSummary {
  delivered: number;
  retrying: number;
  failed: number;
}

async function inPool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    }),
  );
  return results;
}

/**
 * Sends what `WebhookEventsService` queued — the outbox's other half.
 *
 * Queued deliveries are written in the transaction that made the change, and
 * sent from here after it has committed: never inside a database
 * transaction, so a receiver that takes ten seconds holds no locks, and a
 * change that rolls back never announces itself.
 *
 * A tenant that just queued something is looked at every two seconds for a
 * short while (`kick`), so a receiver usually hears within a few seconds; a
 * sweep every thirty seconds catches retries that have come due and anything
 * another server queued.
 *
 * Each delivery is claimed (`lockedUntil`) before it's sent, so two servers —
 * or the sweep and a "Retry" click — never send the same one twice at once.
 * Delivery is still at-least-once: a receiver that took the request but
 * timed out answering gets it again, and de-duplicates on the event `id`.
 */
@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly kicked = new Map<string, number>();
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: WebhookSender,
  ) {}

  /** Something was queued for this tenant — look within seconds rather than at the next sweep. */
  kick(tenantId: string): void {
    this.kicked.set(tenantId, Date.now() + KICK_WINDOW_MS);
  }

  @Interval(2_000)
  async dispatchKicked(): Promise<void> {
    if (this.busy || this.kicked.size === 0) return;
    const now = Date.now();
    for (const [tenantId, until] of this.kicked) if (until <= now) this.kicked.delete(tenantId);
    await this.runFor([...this.kicked.keys()]);
  }

  @Interval(30_000)
  async sweep(): Promise<void> {
    if (this.busy) return;
    // `webhook_deliveries` is row-level secured, so tenants are listed first
    // and each looked at under its own context — the comms dispatcher's way.
    const tenants = await this.prisma.tenant.findMany({ where: { status: { in: ['trial', 'active'] } }, select: { id: true } });
    await this.runFor(tenants.map((tenant) => tenant.id));
  }

  /** Deliveries older than the retention window go, whatever became of them. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async prune(): Promise<number> {
    const before = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    let removed = 0;
    for (const tenant of tenants) {
      try {
        const { count } = await this.prisma.withTenant(tenant.id, (tx) => tx.webhookDelivery.deleteMany({ where: { createdAt: { lt: before } } }));
        removed += count;
      } catch (err) {
        this.logger.error(`Pruning webhook deliveries failed for tenant ${tenant.id}`, err);
      }
    }
    return removed;
  }

  private async runFor(tenantIds: string[]): Promise<void> {
    this.busy = true;
    try {
      for (const tenantId of tenantIds) {
        try {
          const summary = await this.dispatchForTenant(tenantId);
          if (summary.failed > 0) this.logger.warn(`Webhooks for tenant ${tenantId}: ${summary.delivered} delivered, ${summary.retrying} to retry, ${summary.failed} given up on`);
        } catch (err) {
          // One tenant's trouble never stops the others' deliveries.
          this.logger.error(`Webhook dispatch failed for tenant ${tenantId}`, err);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Sends every delivery that's due at this tenant, a batch at a time. Public for tests and the sweep alike. */
  async dispatchForTenant(tenantId: string): Promise<DispatchSummary> {
    const now = new Date();
    const due = await this.prisma.withTenant(tenantId, (tx) =>
      tx.webhookDelivery.findMany({
        where: { status: 'pending', nextAttemptAt: { lte: now }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        orderBy: { nextAttemptAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true },
      }),
    );
    const outcomes = await inPool(due, CONCURRENCY, (delivery) => this.attempt(tenantId, delivery.id));
    const summary: DispatchSummary = { delivered: 0, retrying: 0, failed: 0 };
    for (const outcome of outcomes) {
      if (outcome?.status === 'delivered') summary.delivered += 1;
      else if (outcome?.status === 'pending') summary.retrying += 1;
      else if (outcome?.status === 'failed') summary.failed += 1;
    }
    return summary;
  }

  /**
   * Claims one pending delivery, sends it, and records what happened. Null
   * when it wasn't there to claim — sent already, or being sent elsewhere.
   */
  async attempt(tenantId: string, deliveryId: string): Promise<DeliveryView | null> {
    const now = new Date();
    const claimed = await this.prisma.withTenant(tenantId, async (tx) => {
      const { count } = await tx.webhookDelivery.updateMany({
        where: { id: deliveryId, status: 'pending', OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        data: { lockedUntil: new Date(now.getTime() + CLAIM_MS) },
      });
      if (count !== 1) return null;
      return tx.webhookDelivery.findFirst({ where: { id: deliveryId }, include: { webhook: { select: { url: true, secret: true, isActive: true } } } });
    });
    if (!claimed) return null;

    if (!claimed.webhook.isActive) {
      return this.record(tenantId, deliveryId, { status: 'failed', lastError: 'The webhook was switched off before this was sent', lockedUntil: null });
    }

    const body = JSON.stringify(claimed.payload);
    const result = await this.sender.send(claimed.webhook.url, body, {
      'User-Agent': 'Roomick-Webhooks/1.0',
      'Roomick-Event': claimed.eventType,
      'Roomick-Delivery': claimed.id,
      'Roomick-Signature': signatureHeader(claimed.webhook.secret, body, Math.floor(Date.now() / 1000)),
    });

    const attempts = claimed.attempts + 1;
    // A test is one try: whoever pressed the button is waiting on the answer.
    const lastTry = attempts >= MAX_ATTEMPTS || claimed.eventType === TEST_EVENT_TYPE;
    const outcome: Prisma.WebhookDeliveryUpdateInput = result.ok
      ? { status: 'delivered', deliveredAt: new Date(), lastError: null }
      : lastTry
        ? { status: 'failed', lastError: result.error }
        : { status: 'pending', nextAttemptAt: new Date(Date.now() + RETRY_DELAYS_MS[attempts - 1]), lastError: result.error };
    return this.record(tenantId, deliveryId, { ...outcome, attempts, lastAttemptAt: new Date(), responseStatus: result.status, lockedUntil: null });
  }

  private async record(tenantId: string, deliveryId: string, data: Prisma.WebhookDeliveryUpdateInput): Promise<DeliveryView> {
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.webhookDelivery.update({ where: { id: deliveryId }, data, select: DELIVERY_SELECT }));
    return toDeliveryView(row);
  }

  /** "Send test": a sample event to one webhook, sent now, with the answer returned to whoever asked. */
  async sendTest(tenantId: string, webhookId: string): Promise<DeliveryView> {
    const delivery = await this.prisma.withTenant(tenantId, async (tx) => {
      const webhook = await tx.webhook.findFirst({ where: { id: webhookId }, select: { id: true, branchId: true, isActive: true } });
      if (!webhook) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Webhook not found' });
      if (!webhook.isActive) throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This webhook is switched off — switch it on to test it' });
      const eventId = randomUUID();
      const payload: WebhookPayload = {
        id: eventId,
        type: TEST_EVENT_TYPE,
        createdAt: new Date().toISOString(),
        tenantId,
        branchId: webhook.branchId,
        data: { message: 'A test from Roomick. If you can read this, your endpoint receives webhooks.' },
      };
      return tx.webhookDelivery.create({
        data: { tenantId, webhookId, eventId, eventType: TEST_EVENT_TYPE, payload: payload as unknown as Prisma.InputJsonObject },
        select: { id: true },
      });
    });
    const sent = await this.attempt(tenantId, delivery.id);
    if (!sent) throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'The test is already being sent' });
    return sent;
  }

  /** "Retry": one more try now, for a delivery waiting on a retry or given up on. */
  async retryNow(tenantId: string, deliveryId: string): Promise<DeliveryView> {
    const now = new Date();
    await this.prisma.withTenant(tenantId, async (tx) => {
      const delivery = await tx.webhookDelivery.findFirst({ where: { id: deliveryId }, select: { status: true } });
      if (!delivery) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Delivery not found' });
      if (delivery.status === 'delivered') throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This was delivered already' });
      await tx.webhookDelivery.updateMany({
        where: { id: deliveryId, status: { not: 'delivered' }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        data: { status: 'pending', nextAttemptAt: now },
      });
    });
    const sent = await this.attempt(tenantId, deliveryId);
    if (!sent) throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This is being sent right now — check again in a moment' });
    return sent;
  }
}
