import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketingService } from './marketing.service';

/**
 * A send left in `sending` this long was interrupted (a restart, a crash
 * mid-batch) rather than still running — a single chunk of 100 takes well
 * under a second — so the sweep picks it up and finishes it. The unique
 * (campaign, guest) index is what makes finishing it safe.
 */
const STALLED_AFTER_MS = 10 * 60_000;

/**
 * Sends scheduled campaigns when their time comes.
 *
 * This only decides WHEN. `MarketingService.sendCampaign` writes the
 * messages, and `CommsDispatcherService` delivers them on its own tick — so
 * a scheduled campaign goes through exactly the path a "Send now" does.
 *
 * `marketing_campaigns` is RLS-scoped, so the sweep lists tenants first and
 * works inside each one, the same shape as the comms dispatcher and the
 * nightly backups. One tenant's failure never stops another's campaigns.
 */
@Injectable()
export class CampaignSchedulerService {
  private readonly logger = new Logger(CampaignSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketingService: MarketingService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sendDueCampaigns(): Promise<{ sent: number; failed: number }> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: { in: ['trial', 'active'] } }, select: { id: true } });
    const totals = { sent: 0, failed: 0 };

    for (const tenant of tenants) {
      try {
        const result = await this.sendDueForTenant(tenant.id);
        totals.sent += result.sent;
        totals.failed += result.failed;
      } catch (err) {
        this.logger.error(`Campaign sweep failed for tenant ${tenant.id}`, err);
      }
    }

    if (totals.sent || totals.failed) {
      this.logger.log(`Scheduled campaigns: ${totals.sent} sent, ${totals.failed} failed`);
    }
    return totals;
  }

  /** Public so it can be driven directly in tests without waiting on the cron tick. */
  async sendDueForTenant(tenantId: string, now: Date = new Date()): Promise<{ sent: number; failed: number }> {
    const due = await this.prisma.withTenant(tenantId, (tx) =>
      tx.marketingCampaign.findMany({
        where: {
          OR: [
            { status: 'scheduled', scheduledAt: { lte: now } },
            { status: 'sending', updatedAt: { lt: new Date(now.getTime() - STALLED_AFTER_MS) } },
          ],
        },
        select: { id: true },
        orderBy: { scheduledAt: 'asc' },
      }),
    );

    const result = { sent: 0, failed: 0 };
    for (const campaign of due) {
      try {
        await this.marketingService.sendCampaign(tenantId, campaign.id, null);
        result.sent += 1;
      } catch (err) {
        // sendCampaign has already recorded the reason on the campaign and
        // moved it to `failed`, where it stays until someone fixes it — it is
        // not retried here, so a bad segment can't fail every minute forever.
        result.failed += 1;
        this.logger.warn(`Scheduled campaign ${campaign.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }
}
