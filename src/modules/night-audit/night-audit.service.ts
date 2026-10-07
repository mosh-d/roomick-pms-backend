import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PenaltyType, Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { FoliosService } from '../folios/folios.service';
import { ReservationsService } from '../reservations/reservations.service';

/** `Branch.noShowPolicy` JSON (schema comment: `{cutoffTime, defaultPenalty, autoMark, notifyMinutesBefore}`), plus a flat-fee amount the enum implies but the comment omits. */
interface NoShowPolicy {
  defaultPenalty?: PenaltyType;
  autoMark?: boolean;
  flatFeeAmount?: number;
}

/** How many nights back the scheduled sweep will close out a branch it missed — see `datesToAudit`. */
const CATCH_UP_DAYS = 7;

export interface NightAuditRunResult {
  auditDate: string;
  foliosProcessed: number;
  chargesPosted: number;
  totalAmountPosted: string;
  noShowsMarked: number;
  errors: { reservationId: string; reason: string }[];
  status: 'completed' | 'failed';
}

@Injectable()
export class NightAuditService {
  private readonly logger = new Logger(NightAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    private readonly foliosService: FoliosService,
    private readonly reservationsService: ReservationsService,
  ) {}

  /** The date a run closes: yesterday in the branch's own timezone — the night that just ended. */
  yesterdayForBranch(timezone: string): string {
    const today = toBranchDate(todayInTimezone(timezone));
    today.setUTCDate(today.getUTCDate() - 1);
    return today.toISOString().slice(0, 10);
  }

  /**
   * Runs the night audit for one branch and one date (spec §4.6).
   *
   * Ordering matters: the `night_audit_log` row is written FIRST, inside
   * the transaction, so the `@@unique([branchId, auditDate])` constraint
   * is what actually prevents a double run — a check-then-act guard alone
   * would race two concurrent triggers. The pre-check below exists only to
   * turn that race into a clean 409 in the common case.
   *
   * Per-reservation failures are collected into `errors` and the batch
   * continues — one broken folio must never stop the branch's whole
   * close-out (spec §4.6: "continue on error, never abort the batch").
   */
  async runAudit(tenantId: string, branchId: string, auditDateStr: string, triggeredBy: string | null): Promise<NightAuditRunResult> {
    const auditDate = toBranchDate(auditDateStr);

    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);

      const already = await tx.nightAuditLog.findFirst({ where: { branchId, auditDate } });
      if (already) {
        throw new ConflictException({
          code: ErrorCode.AUDIT_ALREADY_RAN,
          message: `Night audit for ${auditDateStr} has already run for this branch`,
        });
      }

      const log = await tx.nightAuditLog.create({
        data: { tenantId, branchId, auditDate, triggeredBy, status: 'running' },
      });

      const errors: { reservationId: string; reason: string }[] = [];
      let foliosProcessed = 0;
      let chargesPosted = 0;
      let totalAmountPosted = new Prisma.Decimal(0);

      // 1. Post the night that just ended for everyone in the hotel that
      //    night. Occupancy is what counts, not the booked dates — a guest
      //    still checked in after their departure date is still in the room,
      //    and owes the night like any other (the in-house PMS's own rule).
      //    Those overstay nights are labelled so they stand out on the bill
      //    and on Alerts until the desk checks the guest out or extends the
      //    stay. A booked departure day is never billed: someone who leaves
      //    on it is checked out before this runs.
      const inHouse = await tx.reservation.findMany({
        where: {
          branchId,
          deletedAt: null,
          status: 'checked_in',
          checkInDate: { lte: auditDate },
        },
        include: { roomType: { select: { name: true } } },
      });

      for (const reservation of inHouse) {
        try {
          // `triggeredBy` straight through: NULL for the scheduled sweep is
          // `postedBy`'s own "system-posted". It used to fall back to `''` for
          // an online booking (no `createdBy`), which Postgres rejects in the
          // UUID column — aborting the whole audit transaction.
          const folio = await this.foliosService.ensurePrimaryFolio(tx, reservation, triggeredBy);
          const posted = await this.foliosService.postRoomChargeForDate(
            tx,
            reservation,
            folio,
            auditDate,
            reservation.checkOutDate <= auditDate ? 'Night Audit — overstay' : 'Night Audit',
            triggeredBy,
          );
          foliosProcessed++;
          if (posted) {
            chargesPosted++;
            totalAmountPosted = totalAmountPosted.plus(posted.amount).plus(posted.taxAmount);
          }
        } catch (error) {
          errors.push({ reservationId: reservation.id, reason: error instanceof Error ? error.message : 'Unknown error' });
        }
      }

      // 2. Mark no-shows: confirmed arrivals for this date that never checked in.
      const noShowsMarked = await this.markNoShows(tx, tenantId, branchId, auditDate, triggeredBy, errors);

      const status = errors.length > 0 && chargesPosted === 0 && foliosProcessed === 0 ? 'failed' : 'completed';
      await tx.nightAuditLog.update({
        where: { id: log.id },
        data: {
          status,
          foliosProcessed,
          chargesPosted,
          totalAmountPosted,
          errors: errors.length > 0 ? (errors as unknown as Prisma.InputJsonValue) : undefined,
          completedAt: new Date(),
        },
      });

      return {
        auditDate: auditDateStr,
        foliosProcessed,
        chargesPosted,
        totalAmountPosted: totalAmountPosted.toFixed(2),
        noShowsMarked,
        errors,
        status,
      };
    });
  }

  /**
   * A `confirmed` reservation whose arrival date has passed without a
   * check-in is a no-show. Honours `branch.noShowPolicy.autoMark` — a
   * property that wants front desk to make that call manually gets left
   * alone rather than having reservations silently cancelled out from
   * under them.
   */
  /**
   * `ReservationsService.markNoShowInTx` does the actual work (status
   * flip, `NoShowRecord`, penalty charge, folio settle) — shared with the
   * manual "mark as no-show now" entry point so a night-audit-marked
   * no-show and a front-desk-marked one get identical treatment. This
   * batch loop's own job is just: honour `autoMark`, find who's unarrived,
   * and keep one bad reservation from stopping the rest (spec §4.6).
   */
  private async markNoShows(
    tx: TenantTx,
    tenantId: string,
    branchId: string,
    auditDate: Date,
    triggeredBy: string | null,
    errors: { reservationId: string; reason: string }[],
  ): Promise<number> {
    const branch = await tx.branch.findFirst({ where: { id: branchId } });
    const policy = (branch?.noShowPolicy ?? {}) as NoShowPolicy;
    if (policy.autoMark === false) return 0;

    const penaltyType: PenaltyType = policy.defaultPenalty ?? 'none';
    const unarrived = await tx.reservation.findMany({
      where: { branchId, deletedAt: null, status: 'confirmed', checkInDate: { lte: auditDate } },
    });

    let marked = 0;
    for (const reservation of unarrived) {
      try {
        // `triggeredBy` here is whoever triggered THIS AUDIT RUN — `null`
        // for the scheduled sweep, or a real user id for a manually
        // triggered run — carried straight through as `markedBy` (the
        // schema's own "NULL = auto-marked" convention still holds for
        // the sweep; a human-triggered audit correctly attributes the
        // no-shows it marks to that human, same as the original code did).
        await this.reservationsService.markNoShowInTx(tx, tenantId, reservation, penaltyType, policy.flatFeeAmount, triggeredBy);
        marked++;
      } catch (error) {
        errors.push({ reservationId: reservation.id, reason: error instanceof Error ? error.message : 'Unknown error' });
      }
    }
    return marked;
  }

  /**
   * Everything the Night Audit screen needs before letting someone trigger
   * a run (ref p35's "Pre-audit Info"): what date would be closed, whether
   * it already ran, who's still due out, which folios are open, and which
   * arrivals never showed.
   */
  async getPreflight(tenantId: string, branchId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const auditDate = this.yesterdayForBranch(branch.timezone);
      const auditDateValue = toBranchDate(auditDate);
      const today = toBranchDate(todayInTimezone(branch.timezone));

      const [alreadyRan, dueOut, openFolios, unresolvedNoShows, urgentWork, openShifts] = await Promise.all([
        tx.nightAuditLog.findFirst({ where: { branchId, auditDate: auditDateValue } }),
        // Departures whose checkout date has passed but who are still in-house.
        tx.reservation.findMany({
          where: { branchId, deletedAt: null, status: 'checked_in', checkOutDate: { lte: today } },
          include: { guest: { select: { name: true } }, room: { select: { number: true } } },
        }),
        tx.folio.findMany({
          where: { branchId, deletedAt: null, status: { not: 'settled' } },
          include: { guest: { select: { name: true } } },
          orderBy: { openedAt: 'desc' },
        }),
        tx.reservation.findMany({
          where: { branchId, deletedAt: null, status: 'confirmed', checkInDate: { lte: auditDateValue } },
          include: { guest: { select: { name: true } } },
        }),
        tx.maintenanceOrder.count({ where: { branchId, priority: 'urgent', status: { in: ['open', 'in_progress', 'on_hold'] } } }),
        tx.shift.findMany({ where: { branchId, closedAt: null }, select: { shiftType: true } }),
      ]);
      const nightShiftOpen = openShifts.some((shift) => shift.shiftType === 'night');

      return {
        auditDate,
        alreadyRan: alreadyRan !== null,
        checklist: [
          {
            key: 'departures_resolved',
            label: 'All expected departures checked out or marked no-show',
            passed: dueOut.length === 0,
            detail: dueOut.length > 0 ? `${dueOut.length} still in-house past check-out` : null,
          },
          // An urgent work order still open is the blocking kind — a room
          // that can't be sold, or a hazard to deal with before the night.
          {
            key: 'maintenance_clear',
            label: 'No blocking maintenance issues',
            passed: urgentWork === 0,
            detail: urgentWork > 0 ? `${urgentWork} urgent work ${urgentWork === 1 ? 'order' : 'orders'} still open` : null,
          },
          {
            key: 'shift_open',
            label: 'Night shift is open',
            passed: nightShiftOpen,
            detail: nightShiftOpen ? null : openShifts.length > 0 ? 'A shift is open, but not a night shift' : 'No shift is open',
          },
        ],
        openFolios: openFolios.map((f) => ({ id: f.id, guestName: f.guest.name })),
        unresolvedNoShows: unresolvedNoShows.map((r) => ({
          id: r.id,
          confirmationNumber: r.confirmationNumber,
          guestName: r.guest.name,
          checkInDate: r.checkInDate,
        })),
      };
    });
  }

  async listRuns(tenantId: string, branchId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const runs = await tx.nightAuditLog.findMany({
        where: { branchId },
        orderBy: { auditDate: 'desc' },
        take: 30,
      });
      // `id` is a BigInt (append-only log) — JSON.stringify would throw on it.
      // `currency` rides along so the client can render `totalAmountPosted`
      // with a symbol, same as every other money response.
      return runs.map((r) => ({ ...r, id: r.id.toString(), currency: branch.currency }));
    });
  }

  /**
   * The nights the sweep still owes a branch, oldest first: every day since
   * its last audit up to yesterday, so a night the server was down for (a
   * deploy at the wrong hour, an outage) is still closed out — its in-house
   * guests still billed, its no-shows still marked — instead of skipped for
   * good. Capped at a week back: a branch idle longer than that (or never
   * audited) starts from yesterday, rather than suddenly billing weeks of
   * nights nobody was watching; those can still be run by hand.
   */
  async datesToAudit(tenantId: string, branchId: string, timezone: string): Promise<string[]> {
    const yesterday = toBranchDate(this.yesterdayForBranch(timezone));
    const earliest = new Date(yesterday);
    earliest.setUTCDate(earliest.getUTCDate() - (CATCH_UP_DAYS - 1));
    const done = await this.prisma.withTenant(tenantId, (tx) =>
      tx.nightAuditLog.findMany({ where: { branchId, auditDate: { gte: earliest, lte: yesterday } }, select: { auditDate: true } }),
    );
    const doneDates = new Set(done.map((run) => run.auditDate.toISOString().slice(0, 10)));
    const latest = await this.prisma.withTenant(tenantId, (tx) =>
      tx.nightAuditLog.findFirst({ where: { branchId }, orderBy: { auditDate: 'desc' }, select: { auditDate: true } }),
    );
    // Nothing ever run, or nothing within the week: just yesterday.
    const start = latest && latest.auditDate >= earliest ? new Date(latest.auditDate) : new Date(yesterday);
    const dates: string[] = [];
    for (const night = start; night <= yesterday; night.setUTCDate(night.getUTCDate() + 1)) {
      const date = night.toISOString().slice(0, 10);
      if (!doneDates.has(date)) dates.push(date);
    }
    return dates;
  }

  /**
   * The scheduled sweep. Runs hourly rather than at one fixed hour because
   * branches have their own timezones — a single fixed-time cron would fire
   * at the wrong local hour for most of them. Each pass asks, per branch,
   * "is it past the audit hour locally, and is yesterday still unaudited?"
   *
   * `tenants` is deliberately NOT row-level-security scoped (see the RLS
   * migration's own carve-out), which is what lets a request-less cron
   * enumerate them at all; every per-tenant read then goes back through
   * `withTenant`.
   */
  async runScheduledSweep(auditHourLocal = 3): Promise<void> {
    // Suspended/cancelled tenants aren't operating, so there's nothing to
    // close out for them — auditing them would post charges to accounts
    // that shouldn't be accruing.
    const tenants = await this.prisma.tenant.findMany({
      where: { status: { in: ['trial', 'active'] } },
      select: { id: true },
    });

    for (const tenant of tenants) {
      let branches: { id: string; timezone: string }[] = [];
      try {
        branches = await this.prisma.withTenant(tenant.id, (tx) =>
          tx.branch.findMany({ where: { deletedAt: null }, select: { id: true, timezone: true } }),
        );
      } catch (error) {
        this.logger.error(`Night audit sweep: could not list branches for tenant ${tenant.id}`, error);
        continue;
      }

      for (const branch of branches) {
        try {
          const localHour = Number(
            new Intl.DateTimeFormat('en-GB', { timeZone: branch.timezone, hour: '2-digit', hour12: false }).format(new Date()),
          );
          if (localHour < auditHourLocal) continue;

          for (const auditDate of await this.datesToAudit(tenant.id, branch.id, branch.timezone)) {
            const result = await this.runAudit(tenant.id, branch.id, auditDate, null);
            this.logger.log(
              `Night audit ${result.status}: branch ${branch.id} date ${auditDate} — ${result.chargesPosted} charges, ${result.noShowsMarked} no-shows`,
            );
          }
        } catch (error) {
          // One branch failing must not stop the sweep for the rest.
          this.logger.error(`Night audit failed for branch ${branch.id}`, error);
        }
      }
    }
  }
}
