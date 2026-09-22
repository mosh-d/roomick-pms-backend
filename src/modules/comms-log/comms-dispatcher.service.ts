import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MAIL_TRANSPORT, MailTransport } from '../../common/mail/mail-transport.interface';
import { PrismaService } from '../../prisma/prisma.service';

/** One pass never drains more than this, so a large backlog can't monopolise a tick or blow memory. The next tick picks up the rest. */
const BATCH_SIZE = 50;

/** Only this channel has a real transport. See `dispatchForTenant` for why the others are deliberately left alone. */
const DISPATCHABLE_CHANNEL = 'email' as const;

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
        where: { deliveryStatus: 'queued', channel: DISPATCHABLE_CHANNEL, direction: 'outbound' },
        orderBy: { sentAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true, subject: true, body: true, bodyHtml: true, guest: { select: { email: true } } },
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
        // Left as `failed` rather than returned to `queued`: without an
        // attempt counter on the row there's nothing to stop an endless retry
        // loop against a permanently broken address. A real retry policy
        // wants an `attempts` column and a backoff, which is its own change.
        this.logger.warn(`Failed to send communication ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        await this.markFailed(tenantId, row.id);
        summary.failed += 1;
      }
    }

    // Non-email channels (sms, push, in_app_chat) are deliberately NOT
    // counted or touched — they have no transport, so marking them anything
    // other than `queued` would claim a delivery that never happened. They
    // stay queued honestly until a transport exists.
    return summary;
  }

  private async markFailed(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) => tx.communicationLog.update({ where: { id }, data: { deliveryStatus: 'failed' } }));
  }
}
