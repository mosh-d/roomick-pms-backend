import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DOCUMENT_STORAGE_ADAPTER, DocumentStorageAdapter } from '../../common/documents/document-storage.interface';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';

/** What a removed card says where the guest's name was. */
export const RETENTION_REMOVED_NAME = 'Removed after the retention period';

/** The shortest and longest periods an owner can choose, in months. */
export const MIN_RETENTION_MONTHS = 6;
export const MAX_RETENTION_MONTHS = 240;

/** Rows per transaction — a first run over years of cards is done in small steps, not one long lock. */
const BATCH = 200;

export interface RetentionStatus {
  /** null = keep everything (the default). */
  months: number | null;
  /** What's past that period now, and goes at the next nightly run. */
  due: { registrationCards: number; idDocuments: number };
}

export interface RetentionRun {
  registrationCards: number;
  idDocuments: number;
  filesDeleted: number;
}

/**
 * Document retention: how long registration cards and guests' ID documents
 * are kept after a stay. Off until the owner chooses a period; then, every
 * night, what's older goes:
 *
 * - **Registration cards** of stays that ended before the period: the guest's
 *   name, email and phone, the signature and the stored PDF. The card itself
 *   stays — room, dates, rate and confirmation number are the business's own
 *   record of the stay, not the guest's personal data.
 * - **ID documents** of guests whose last stay ended before the period and
 *   who have nothing booked: the type, number, expiry and the photo. They're
 *   asked for ID again at their next check-in, as on a first visit.
 *
 * Bills, payments and stays are never touched. Files are deleted after the
 * database change commits, as in an erasure, so a failure can't leave a
 * record pointing at a file that's gone.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_STORAGE_ADAPTER) private readonly documentStorage: DocumentStorageAdapter,
  ) {}

  /** The setting and what it would remove now — or, with `months`, what that period would remove (nothing is changed). */
  async status(tenantId: string, months?: number | null): Promise<RetentionStatus> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { documentRetentionMonths: true } });
    const period = months === undefined ? tenant.documentRetentionMonths : months;
    if (period === null) return { months: null, due: { registrationCards: 0, idDocuments: 0 } };
    assertPeriod(period);
    const cutoff = cutoffFor(period);
    const [registrationCards, idDocuments] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([tx.registrationCard.count({ where: cardsDue(cutoff) }), tx.guestProfile.count({ where: idDocumentsDue(cutoff) })]),
    );
    return { months: period, due: { registrationCards, idDocuments } };
  }

  async setPeriod(tenantId: string, months: number | null, actorId: string): Promise<RetentionStatus> {
    if (months !== null) assertPeriod(months);
    await this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { documentRetentionMonths: true } });
      await tx.tenant.update({ where: { id: tenantId }, data: { documentRetentionMonths: months } });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actorId,
          action: 'retention.period_set',
          entityType: 'tenant',
          entityId: tenantId,
          before: { months: before.documentRetentionMonths },
          after: { months },
        },
      });
    });
    return this.status(tenantId);
  }

  /** Every tenant with a period set — the nightly run. */
  /**
   * Rate quotes that never became a booking: every price preview writes a
   * `rate_audit_log` row and nothing ever removed them. Rows linked to a
   * reservation are billing evidence and stay; unlinked ones go after 90 days.
   */
  async pruneRateQuotes(now = new Date()): Promise<number> {
    const RATE_QUOTE_RETENTION_DAYS = 90;
    const cutoff = new Date(now.getTime() - RATE_QUOTE_RETENTION_DAYS * 86_400_000);
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    let removed = 0;
    for (const tenant of tenants) {
      try {
        const result = await this.prisma.withTenant(tenant.id, (tx) => tx.rateAuditLog.deleteMany({ where: { reservationId: null, resolvedAt: { lt: cutoff } } }));
        removed += result.count;
      } catch (error) {
        this.logger.error(`Rate-quote pruning failed for tenant ${tenant.id}`, error);
      }
    }
    return removed;
  }

  async purgeAll(): Promise<RetentionRun> {
    const tenants = await this.prisma.tenant.findMany({ where: { documentRetentionMonths: { not: null } }, select: { id: true } });
    const total: RetentionRun = { registrationCards: 0, idDocuments: 0, filesDeleted: 0 };
    for (const tenant of tenants) {
      try {
        const run = await this.purgeTenant(tenant.id, null);
        total.registrationCards += run.registrationCards;
        total.idDocuments += run.idDocuments;
        total.filesDeleted += run.filesDeleted;
      } catch (error) {
        // One tenant's failure doesn't stop the others; it's tried again tomorrow.
        this.logger.error(`Retention run failed for tenant ${tenant.id}`, error);
      }
    }
    return total;
  }

  /** One tenant, now — the nightly run, or the owner's "remove what's due now". */
  async purgeTenant(tenantId: string, actorId: string | null): Promise<RetentionRun> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { documentRetentionMonths: true } });
    const run: RetentionRun = { registrationCards: 0, idDocuments: 0, filesDeleted: 0 };
    if (tenant.documentRetentionMonths === null) return run;
    const cutoff = cutoffFor(tenant.documentRetentionMonths);

    for (;;) {
      const files: string[] = [];
      const done = await this.prisma.withTenant(tenantId, async (tx) => {
        const cards = await this.purgeCards(tx, cutoff, files);
        const ids = await this.purgeIdDocuments(tx, cutoff, files);
        return { cards, ids };
      });
      run.registrationCards += done.cards;
      run.idDocuments += done.ids;
      for (const url of files) {
        try {
          await this.documentStorage.remove(url);
          run.filesDeleted += 1;
        } catch (error) {
          // Nothing points at it any more and it's encrypted at rest; logged for someone to clear by hand.
          this.logger.warn(`Retention: could not delete ${url}`, error);
        }
      }
      if (done.cards < BATCH && done.ids < BATCH) break;
    }

    if (run.registrationCards > 0 || run.idDocuments > 0) {
      // Counts only — the audit trail must not become the copy of what was removed.
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId,
            userId: actorId,
            action: 'retention.purged',
            entityType: 'tenant',
            entityId: tenantId,
            after: { months: tenant.documentRetentionMonths, registrationCards: run.registrationCards, idDocuments: run.idDocuments, filesDeleted: run.filesDeleted },
          },
        }),
      );
    }
    return run;
  }

  private async purgeCards(tx: TenantTx, cutoff: Date, files: string[]): Promise<number> {
    const cards = await tx.registrationCard.findMany({ where: cardsDue(cutoff), take: BATCH });
    const now = new Date();
    for (const card of cards) {
      const fields = card.fields && typeof card.fields === 'object' && !Array.isArray(card.fields) ? card.fields : {};
      await tx.registrationCard.update({
        where: { id: card.id },
        data: {
          fields: { ...fields, guestName: RETENTION_REMOVED_NAME, guestEmail: null, guestPhone: null },
          signatureData: null,
          documentUrl: null,
          purgedAt: now,
        },
      });
      if (card.documentUrl) files.push(card.documentUrl);
    }
    return cards.length;
  }

  private async purgeIdDocuments(tx: TenantTx, cutoff: Date, files: string[]): Promise<number> {
    const guests = await tx.guestProfile.findMany({ where: idDocumentsDue(cutoff), select: { id: true, idDocUrl: true }, take: BATCH });
    if (guests.length === 0) return 0;
    await tx.guestProfile.updateMany({
      where: { id: { in: guests.map((g) => g.id) } },
      data: { idDocType: null, idDocNumber: null, idDocUrl: null, idDocExpiryDate: null },
    });
    for (const guest of guests) if (guest.idDocUrl) files.push(guest.idDocUrl);
    return guests.length;
  }
}

/** Cards of stays that ended before the cutoff, not already removed. A stay still in the house is never "ended". */
function cardsDue(cutoff: Date): Prisma.RegistrationCardWhereInput {
  return { purgedAt: null, reservation: { checkOutDate: { lt: cutoff }, status: { notIn: ['confirmed', 'checked_in'] } } };
}

/** Guests holding an ID document whose last stay ended before the cutoff, with nothing booked or in progress. */
function idDocumentsDue(cutoff: Date): Prisma.GuestProfileWhereInput {
  return {
    deletedAt: null,
    createdAt: { lt: cutoff },
    OR: [{ idDocType: { not: null } }, { idDocNumber: { not: null } }, { idDocUrl: { not: null } }, { idDocExpiryDate: { not: null } }],
    reservations: { none: { OR: [{ status: { in: ['confirmed', 'checked_in'] } }, { checkOutDate: { gte: cutoff } }] } },
  };
}

/** The day the period reaches back to — stays that ended before it are past it. */
export function cutoffFor(months: number, now = new Date()): Date {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

function assertPeriod(months: number): void {
  if (!Number.isInteger(months) || months < MIN_RETENTION_MONTHS || months > MAX_RETENTION_MONTHS) {
    throw new BadRequestException({
      code: ErrorCode.VALIDATION_FAILED,
      message: `Choose a whole number of months from ${MIN_RETENTION_MONTHS} to ${MAX_RETENTION_MONTHS}`,
    });
  }
}
