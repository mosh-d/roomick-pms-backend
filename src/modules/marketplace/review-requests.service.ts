import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { REVIEW_REQUEST_TRIGGER, parseReviewRequestConfig, renderReviewRequest, reviewWindow } from './connectors/review-requests';
import { MarketplaceService } from './marketplace.service';

/** One sweep never writes more than this per tenant; the next picks up the rest. */
const BATCH_SIZE = 200;

/**
 * Sends review requests for stays that ended long enough ago.
 *
 * It writes ordinary `CommunicationLog` rows — attached to the stay, trigger
 * `review_request` — and `CommsDispatcherService` delivers them, as it does
 * every other email. One per stay: a reservation that already has a request
 * is skipped, so a sweep that runs twice, or a setting changed mid-week,
 * never asks the same guest twice for the same stay.
 *
 * Like the other sweeps, it lists tenants first (connections are RLS-scoped)
 * and works inside each, and one tenant's failure never stops another's.
 */
@Injectable()
export class ReviewRequestsService {
  private readonly logger = new Logger(ReviewRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    private readonly marketplaceService: MarketplaceService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sendDueRequests(): Promise<number> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: { in: ['trial', 'active'] } }, select: { id: true } });
    let total = 0;
    for (const tenant of tenants) {
      try {
        total += await this.sendDueForTenant(tenant.id);
      } catch (err) {
        this.logger.error(`Review-request sweep failed for tenant ${tenant.id}`, err);
      }
    }
    if (total) this.logger.log(`Queued ${total} review request(s)`);
    return total;
  }

  /** Public so it can be driven directly (tests, a live check) without waiting for the tick. */
  async sendDueForTenant(tenantId: string, now: Date = new Date()): Promise<number> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const connection = await tx.integrationConnection.findFirst({ where: { provider: 'review_requests', status: 'enabled' } });
      if (!connection) return 0;

      const branches = await tx.branch.findMany({ where: { deletedAt: null }, select: { id: true, name: true } });
      const config = parseReviewRequestConfig(connection.config, branches.map((branch) => branch.id));
      const { from, to } = reviewWindow(now, connection.enabledAt, config.delayHours);
      if (from >= to) return 0;

      const due = await tx.reservation.findMany({
        where: {
          branchId: { in: Object.keys(config.links) },
          status: 'checked_out',
          deletedAt: null,
          actualCheckOut: { gte: from, lte: to },
          guest: {
            deletedAt: null,
            email: { not: null },
            // Someone who asked the hotel to stop emailing them offers isn't
            // asked for a favour either, even though this isn't an offer.
            marketingUnsubscribedAt: null,
          },
          communicationLogs: { none: { trigger: REVIEW_REQUEST_TRIGGER } },
        },
        select: { id: true, branchId: true, guestId: true, guest: { select: { name: true } } },
        orderBy: { actualCheckOut: 'asc' },
        take: BATCH_SIZE,
      });

      const hotelNames = new Map(branches.map((branch) => [branch.id, branch.name]));
      for (const stay of due) {
        const { subject, body } = renderReviewRequest(config, {
          guestName: stay.guest.name,
          hotelName: hotelNames.get(stay.branchId) ?? '',
          reviewUrl: config.links[stay.branchId],
        });
        await tx.communicationLog.create({
          data: {
            tenantId,
            branchId: stay.branchId,
            reservationId: stay.id,
            guestId: stay.guestId,
            channel: 'email',
            subject,
            body,
            trigger: REVIEW_REQUEST_TRIGGER,
            deliveryStatus: 'queued',
            sentBy: null,
          },
        });
      }

      if (due.length > 0) {
        await tx.integrationConnection.update({
          where: { id: connection.id },
          data: { lastRunAt: now, lastRunSummary: `Asked ${due.length} guest${due.length === 1 ? '' : 's'} for a review` },
        });
      }
      return due.length;
    });
  }

  /** The email as a guest at this property would get it, with a sample name — for the settings page. */
  async preview(tenantId: string, branchId: string): Promise<{ subject: string; body: string; reviewUrl: string | null }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const connection = await this.marketplaceService.enabledConnection(tx, 'review_requests');
      const branches = await tx.branch.findMany({ where: { deletedAt: null }, select: { id: true } });
      const config = parseReviewRequestConfig(connection.config, branches.map((b) => b.id));
      const reviewUrl = config.links[branchId] ?? null;
      const rendered = renderReviewRequest(config, { guestName: 'Kemi Adeyemi', hotelName: branch.name, reviewUrl: reviewUrl ?? '(no review page set for this property)' });
      return { ...rendered, reviewUrl };
    });
  }
}
