import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MAIL_TRANSPORT, MailTransport } from '../../common/mail/mail-transport.interface';
import { PrismaService } from '../../prisma/prisma.service';

/** One pass never drains more than this, so a large backlog can't monopolise a tick or blow memory. The next tick picks up the rest. */
const BATCH_SIZE = 50;

/** Only this channel has a real transport. See `dispatchForTenant` for why the others are deliberately left alone. */
const DISPATCHABLE_CHANNEL = 'email' as const;

/**
 * The same schedule the webhook dispatcher uses: a provider timeout at two
 * in the morning is tried again a minute later, then at growing intervals
 * for about a day, before the message is given up on. A send error used to
 * mark the row `failed` on the first try — one SMTP hiccup silently dropped
 * every confirmation, invitation and password reset queued that minute.
 */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export interface DispatchSummary {
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Delivers what `CommsLogService` records — the outbox half of the pair.
 *
 * **Why this is a separate scheduled pass and not just a send inside
 * `logAutomatedInTx`:** that method runs inside an already-open reservation
 * transaction (booking, check-in, check-out, cancel). Sending there would put
 * network I/O inside a database transaction — holding row locks for the
 * duration of an external call — and worse, a transaction that later rolled
 * back would leave a real email already delivered for a reservation that no
 * longer exists. An email cannot be un-sent.
 *
 * So the write stays transactional and the send is strictly after-commit: rows
 * land as `queued`, this picks them up, and a rollback simply means the row
 * was never committed for it to find. The schema anticipated this — the
 * `[branchId, deliveryStatus, sentAt]` index exists precisely to make "find
 * the queued ones" cheap.
 *
 * Cross-tenant iteration follows `BackupsService.runNightlyBackups`'s
 * precedent exactly: `communication_log` is RLS-scoped, so there's no way to
 * query every tenant's queue at once. The `tenants` table is the RLS root and
 * isn't scoped, so it's listed first and each tenant processed inside its own
 * `withTenant` transaction.
 */
@Injectable()
export class CommsDispatcherService {
  private readonly logger = new Logger(CommsDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAIL_TRANSPORT) private readonly mailTransport: MailTransport,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async dispatchQueued(): Promise<DispatchSummary> {
    const tenants = await this.prisma.tenant.findMany({
      where: { status: { in: ['trial', 'active'] } },
      select: { id: true },
    });

    const total: DispatchSummary = { sent: 0, failed: 0, skipped: 0 };
    for (const tenant of tenants) {
      try {
        const result = await this.dispatchForTenant(tenant.id);
        total.sent += result.sent;
        total.failed += result.failed;
        total.skipped += result.skipped;
      } catch (err) {
        // One tenant's failure must never stop the others' mail — same
        // isolation the nightly backup sweep applies per tenant.
        this.logger.error(`Comms dispatch failed for tenant ${tenant.id}`, err);
      }
    }

    if (total.sent || total.failed) {
      this.logger.log(`Comms dispatch via "${this.mailTransport.name}": ${total.sent} sent, ${total.failed} failed, ${total.skipped} skipped`);
    }
    return total;
  }

  /**
   * Public so it can be exercised directly (tests, and a future "retry now"
   * admin action) without waiting on the cron tick.
   */
  async dispatchForTenant(tenantId: string): Promise<DispatchSummary> {
    // Read and send OUTSIDE a long transaction. Each row's status update is
    // its own small write, so a transport call that hangs can't hold a lock
    // across the whole batch.
    const queued = await this.prisma.withTenant(tenantId, (tx) =>
      tx.communicationLog.findMany({
        // Outbound only: an inbound email (once a provider's inbound webhook exists) is a message the guest sent US —
        // "dispatching" it would email the guest their own words back.
        where: {
          deliveryStatus: 'queued',
          channel: DISPATCHABLE_CHANNEL,
          direction: 'outbound',
          // Never tried, or due for another try.
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
        },
        orderBy: { sentAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true, subject: true, body: true, bodyHtml: true, attempts: true, guest: { select: { email: true } } },
      }),
    );

    const summary: DispatchSummary = { sent: 0, failed: 0, skipped: 0 };

    for (const row of queued) {
      const recipient = row.guest.email;

      // A guest with no email address can never receive this, no matter how
      // many times it's retried — mark it terminally failed rather than
      // leaving it to be re-read on every tick forever. Walk-ins and
      // phone bookings legitimately have no email, so this is an ordinary
      // outcome, not an error worth logging loudly.
      if (!recipient) {
        await this.markFailed(tenantId, row.id);
        summary.failed += 1;
        continue;
      }

      try {
        const result = await this.mailTransport.send({
          to: recipient,
          subject: row.subject ?? 'Message from your hotel',
          body: row.body,
          // Only a marketing campaign renders an HTML twin; everything else is text only.
          ...(row.bodyHtml ? { html: row.bodyHtml } : {}),
        });
        await this.prisma.withTenant(tenantId, (tx) =>
          tx.communicationLog.update({
            where: { id: row.id },
            // `sent`, never `delivered`: the provider has accepted it, which
            // is not the same as a mailbox receiving it. Only a provider
            // webhook could justify `delivered`, and none is wired.
            data: { deliveryStatus: 'sent', externalMessageId: result.externalMessageId },
          }),
        );
        summary.sent += 1;
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        const attempts = (row.attempts ?? 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          this.logger.warn(`Giving up on communication ${row.id} after ${attempts} attempts: ${reason}`);
          await this.markFailed(tenantId, row.id, attempts, reason);
          summary.failed += 1;
        } else {
          const nextAttemptAt = new Date(Date.now() + RETRY_DELAYS_MS[attempts - 1]);
          this.logger.warn(`Communication ${row.id} failed (attempt ${attempts}), trying again at ${nextAttemptAt.toISOString()}: ${reason}`);
          await this.prisma.withTenant(tenantId, (tx) => tx.communicationLog.update({ where: { id: row.id }, data: { attempts, nextAttemptAt, lastError: reason } }));
          summary.skipped += 1;
        }
      }
    }

    // Non-email channels (sms, push, in_app_chat) are deliberately NOT
    // counted or touched — they have no transport, so marking them anything
    // other than `queued` would claim a delivery that never happened. They
    // stay queued honestly until a transport exists.
    return summary;
  }

  private async markFailed(tenantId: string, id: string, attempts?: number, lastError?: string): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.communicationLog.update({ where: { id }, data: { deliveryStatus: 'failed', ...(attempts !== undefined ? { attempts } : {}), ...(lastError ? { lastError } : {}) } }),
    );
  }
}
