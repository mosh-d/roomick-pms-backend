import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { PenaltyType, Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { FoliosService } from '../folios/folios.service';
import { ReservationsService } from '../reservations/reservations.service';
import { HousekeepingService } from '../housekeeping/housekeeping.service';

/** `Branch.noShowPolicy` JSON (schema comment: `{cutoffTime, defaultPenalty, autoMark, notifyMinutesBefore}`), plus a flat-fee amount the enum implies but the comment omits. */
interface NoShowPolicy {
  defaultPenalty?: PenaltyType;
  autoMark?: boolean;
  flatFeeAmount?: number;
}

/** How many nights back the scheduled sweep will close out a branch it missed — see `datesToAudit`. */
const CATCH_UP_DAYS = 7;

/**
 * Stays closed per transaction. The audit used to close a whole branch in
 * one transaction, and at a few hundred in-house guests it ran past the
 * transaction timeout and rolled back every charge it had posted. A batch
 * this size finishes in well under a second on a slow database; a batch that
 * still fails costs only its own stays, which the next run picks up.
 */
const STAY_BATCH = 25;
/** How long one batch may hold its transaction. */
const BATCH_TIMEOUT_MS = 120_000;
/** A run still "running" after this long died part-way (a deploy, a crash) — the next run picks it up. The schema's own rule. */
const STALE_RUN_MS = 10 * 60_000;

type RunError = { reservationId: string; reason: string };

function inBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error');

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
    private readonly housekeepingService: HousekeepingService,
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
   * The run is claimed first, in its own short transaction: the
   * `night_audit_log` row is written as `running` before any work starts,
   * and the `@@unique([branchId, auditDate])` constraint is what actually
   * prevents a double run — the pre-check only turns the common case into a
   * clean 409.
   *
   * Then the stays are closed in batches, each in its own transaction, and
   * the no-shows the same way; the log row's totals move with every batch.
   * Every step skips what's already done — a night already posted to a folio
   * isn't posted again, a stay-over task already waiting isn't raised again,
   * a no-show already marked is no longer `confirmed` — so a run that failed
   * or died part-way is simply run again and carries on where it stopped.
   * Nothing it posted is lost, and nothing is charged twice.
   *
   * Per-reservation failures are collected into `errors` and the batch
   * continues — one broken folio must never stop the branch's whole
   * close-out (spec §4.6: "continue on error, never abort the batch"). A
   * batch that fails as a whole (a lost connection, a timeout) marks the run
   * `failed`, which leaves the night pending for the next run.
   */
  async runAudit(tenantId: string, branchId: string, auditDateStr: string, triggeredBy: string | null): Promise<NightAuditRunResult> {
    const auditDate = toBranchDate(auditDateStr);
    const claim = await this.claimRun(tenantId, branchId, auditDate, auditDateStr, triggeredBy);

    const errors: RunError[] = [];
    let foliosProcessed = 0;
    let chargesPosted = claim.chargesPosted;
    let totalAmountPosted = claim.totalAmountPosted;
    let noShowsMarked = 0;
    let unfinished = false;

    try {
      // 1. Post the night that just ended for everyone in the hotel that
      //    night. Occupancy is what counts, not the booked dates — a guest
      //    still checked in after their departure date is still in the room,
      //    and owes the night like any other (the in-house PMS's own rule).
      //    Those overstay nights are labelled so they stand out on the bill
      //    and on Alerts until the desk checks the guest out or extends the
      //    stay. A booked departure day is never billed: someone who leaves
      //    on it is checked out before this runs.
      const inHouseWhere = { branchId, deletedAt: null, status: 'checked_in' as const, checkInDate: { lte: auditDate } };
      const stayIds = (
        await this.prisma.withTenant(tenantId, (tx) => tx.reservation.findMany({ where: inHouseWhere, select: { id: true }, orderBy: { id: 'asc' } }))
      ).map((stay) => stay.id);

      // Stay-over service: every room still occupied this morning gets its
      // daily housekeeping task, unless one is already waiting for it.
      const serviceDate = new Date(auditDate.getTime() + 86_400_000);
      let stayoverTasks = 0;

      for (const ids of inBatches(stayIds, STAY_BATCH)) {
        try {
          const batch = await this.prisma.withTenant(
            tenantId,
            async (tx) => {
              // Read again inside the batch: a guest checked out since the run
              // started isn't billed for a night their check-out already settled.
              const stays = await tx.reservation.findMany({ where: { id: { in: ids }, ...inHouseWhere }, include: { roomType: { select: { name: true } } } });
              const done = { processed: 0, posted: 0, amount: new Prisma.Decimal(0), tasks: 0, errors: [] as RunError[] };
              for (const reservation of stays) {
                // Each stay in its own savepoint: a failed statement aborts a
                // Postgres transaction, so without one a single bad folio would
                // poison every post after it in the batch.
                await tx.$executeRawUnsafe('SAVEPOINT night_audit_stay');
                try {
                  // `triggeredBy` straight through: NULL for the scheduled sweep
                  // is `postedBy`'s own "system-posted". It used to fall back to
                  // `''` for an online booking (no `createdBy`), which Postgres
                  // rejects in the UUID column.
                  const folio = await this.foliosService.ensurePrimaryFolio(tx, reservation, triggeredBy);
                  const posted = await this.foliosService.postRoomChargeForDate(
                    tx,
                    reservation,
                    folio,
                    auditDate,
                    reservation.checkOutDate <= auditDate ? 'Night Audit — overstay' : 'Night Audit',
                    triggeredBy,
                  );
                  done.processed++;
                  if (posted) {
                    done.posted++;
                    done.amount = done.amount.plus(posted.amount).plus(posted.taxAmount);
                  }
                  await tx.$executeRawUnsafe('RELEASE SAVEPOINT night_audit_stay');
                } catch (error) {
                  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT night_audit_stay');
                  done.errors.push({ reservationId: reservation.id, reason: reasonOf(error) });
                }
                if (!reservation.roomId) continue;
                await tx.$executeRawUnsafe('SAVEPOINT night_audit_housekeeping');
                try {
                  if (await this.housekeepingService.ensureStayoverTaskInTx(tx, tenantId, branchId, reservation.roomId, reservation.id, serviceDate)) done.tasks++;
                  await tx.$executeRawUnsafe('RELEASE SAVEPOINT night_audit_housekeeping');
                } catch (error) {
                  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT night_audit_housekeeping');
                  done.errors.push({ reservationId: reservation.id, reason: `Housekeeping task: ${reasonOf(error)}` });
                }
              }
              // The totals move with the posts, so a run that dies after this
              // batch is picked up again with the right figures.
              await tx.nightAuditLog.update({
                where: { id: claim.logId },
                data: { chargesPosted: chargesPosted + done.posted, totalAmountPosted: totalAmountPosted.plus(done.amount) },
              });
              return done;
            },
            { timeout: BATCH_TIMEOUT_MS },
          );
          foliosProcessed += batch.processed;
          chargesPosted += batch.posted;
          totalAmountPosted = totalAmountPosted.plus(batch.amount);
          stayoverTasks += batch.tasks;
          errors.push(...batch.errors);
        } catch (error) {
          // The whole batch rolled back. Its stays are still owed the night —
          // the run is marked failed, so the next one closes them.
          unfinished = true;
          this.logger.error(`Night audit ${auditDateStr} branch ${branchId}: a batch of ${ids.length} stays failed`, error);
          for (const id of ids) errors.push({ reservationId: id, reason: `Not closed this run, run it again: ${reasonOf(error)}` });
        }
      }
      if (stayoverTasks > 0) this.logger.log(`Night audit ${auditDateStr}: ${stayoverTasks} stay-over housekeeping task(s) raised`);

      // 2. Mark no-shows: confirmed arrivals for this date that never checked in.
      const noShows = await this.markNoShows(tenantId, branchId, auditDate, triggeredBy, errors);
      noShowsMarked = noShows.marked;
      unfinished ||= noShows.unfinished;
    } catch (error) {
      // Anything that stopped the run outright is on record — the night stays pending.
      unfinished = true;
      errors.push({ reservationId: '', reason: `The run stopped: ${reasonOf(error)}` });
      this.logger.error(`Night audit ${auditDateStr} branch ${branchId} stopped`, error);
    }

    const status: 'completed' | 'failed' = unfinished || (errors.length > 0 && chargesPosted === 0 && foliosProcessed === 0) ? 'failed' : 'completed';
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.nightAuditLog.update({
        where: { id: claim.logId },
        data: {
          status,
          foliosProcessed,
          chargesPosted,
          totalAmountPosted,
          errors: errors.length > 0 ? (errors as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          completedAt: new Date(),
        },
      }),
    );

    return {
      auditDate: auditDateStr,
      foliosProcessed,
      chargesPosted,
      totalAmountPosted: totalAmountPosted.toFixed(2),
      noShowsMarked,
      errors,
      status,
    };
  }

  /**
   * Puts the run on record before any work starts. A night already closed is
   * refused; one being closed right now too. One whose last run failed — or
   * died part-way and has sat "running" past the stale mark — is taken over,
   * keeping the totals it had already posted.
   */
  private async claimRun(
    tenantId: string,
    branchId: string,
    auditDate: Date,
    auditDateStr: string,
    triggeredBy: string | null,
  ): Promise<{ logId: bigint; chargesPosted: number; totalAmountPosted: Prisma.Decimal }> {
    const runningNow = () =>
      new ConflictException({ code: ErrorCode.CONFLICT, message: `The night audit for ${auditDateStr} is running now — give it a few minutes, then refresh` });

    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      // Only a night that has ended can be closed. A date in the future would
      // bill nights nobody has slept yet and mark today's arrivals as no-shows
      // before they've had the chance to arrive — and, since a date is audited
      // once, the real audit for that night could then never run.
      const requested = auditDate.toISOString().slice(0, 10);
      const latest = this.yesterdayForBranch(branch.timezone);
      if (requested > latest) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: `${requested} hasn’t ended yet — the latest night that can be closed is ${latest}`,
        });
      }

      const existing = await tx.nightAuditLog.findFirst({ where: { branchId, auditDate } });
      if (existing) {
        if (existing.status === 'completed') {
          throw new ConflictException({ code: ErrorCode.AUDIT_ALREADY_RAN, message: `Night audit for ${auditDateStr} has already run for this branch` });
        }
        const staleBefore = new Date(Date.now() - STALE_RUN_MS);
        if (existing.status === 'running' && existing.triggeredAt >= staleBefore) throw runningNow();
        // Compare-and-set on the status (and, for an abandoned run, its age),
        // so two people picking up the same failed night can't both run it.
        const taken = await tx.nightAuditLog.updateMany({
          where: { id: existing.id, status: existing.status, ...(existing.status === 'running' ? { triggeredAt: { lt: staleBefore } } : {}) },
          data: { status: 'running', triggeredAt: new Date(), triggeredBy, completedAt: null, errors: Prisma.DbNull },
        });
        if (taken.count === 0) throw runningNow();
        return { logId: existing.id, chargesPosted: existing.chargesPosted ?? 0, totalAmountPosted: existing.totalAmountPosted ?? new Prisma.Decimal(0) };
      }

      try {
        const log = await tx.nightAuditLog.create({ data: { tenantId, branchId, auditDate, triggeredBy, status: 'running' } });
        return { logId: log.id, chargesPosted: 0, totalAmountPosted: new Prisma.Decimal(0) };
      } catch (error) {
        // Someone else's run claimed the night between the check and the insert.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw runningNow();
        throw error;
      }
    });
  }

  /**
   * A `confirmed` reservation whose arrival date has passed without a
   * check-in is a no-show. Honours `branch.noShowPolicy.autoMark` — a
   * property that wants front desk to make that call manually gets left
   * alone rather than having reservations silently cancelled out from
   * under them.
   *
   * `ReservationsService.markNoShowInTx` does the actual work (status
   * flip, `NoShowRecord`, penalty charge, folio settle) — shared with the
   * manual "mark as no-show now" entry point so a night-audit-marked
   * no-show and a front-desk-marked one get identical treatment. This
   * loop's own job is just: honour `autoMark`, find who's unarrived, keep
   * one bad reservation from stopping the rest (spec §4.6), and work in
   * batches like the stays.
   */
  private async markNoShows(
    tenantId: string,
    branchId: string,
    auditDate: Date,
    triggeredBy: string | null,
    errors: RunError[],
  ): Promise<{ marked: number; unfinished: boolean }> {
    const unarrivedWhere = { branchId, deletedAt: null, status: 'confirmed' as const, checkInDate: { lte: auditDate } };
    const { policy, ids } = await this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await tx.branch.findFirst({ where: { id: branchId } });
      const noShowPolicy = (branch?.noShowPolicy ?? {}) as NoShowPolicy;
      if (noShowPolicy.autoMark === false) return { policy: noShowPolicy, ids: [] as string[] };
      const unarrived = await tx.reservation.findMany({ where: unarrivedWhere, select: { id: true }, orderBy: { id: 'asc' } });
      return { policy: noShowPolicy, ids: unarrived.map((r) => r.id) };
    });
    const penaltyType: PenaltyType = policy.defaultPenalty ?? 'none';

    let marked = 0;
    let unfinished = false;
    for (const batchIds of inBatches(ids, STAY_BATCH)) {
      try {
        const batch = await this.prisma.withTenant(
          tenantId,
          async (tx) => {
            const unarrived = await tx.reservation.findMany({ where: { id: { in: batchIds }, ...unarrivedWhere } });
            const done = { marked: 0, errors: [] as RunError[] };
            for (const reservation of unarrived) {
              await tx.$executeRawUnsafe('SAVEPOINT night_audit_no_show');
              try {
                // `triggeredBy` here is whoever triggered THIS AUDIT RUN — `null`
                // for the scheduled sweep, or a real user id for a manually
                // triggered run — carried straight through as `markedBy` (the
                // schema's own "NULL = auto-marked" convention still holds for
                // the sweep; a human-triggered audit correctly attributes the
                // no-shows it marks to that human).
                await this.reservationsService.markNoShowInTx(tx, tenantId, reservation, penaltyType, policy.flatFeeAmount, triggeredBy);
                done.marked++;
                await tx.$executeRawUnsafe('RELEASE SAVEPOINT night_audit_no_show');
              } catch (error) {
                await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT night_audit_no_show');
                done.errors.push({ reservationId: reservation.id, reason: reasonOf(error) });
              }
            }
            return done;
          },
          { timeout: BATCH_TIMEOUT_MS },
        );
        marked += batch.marked;
        errors.push(...batch.errors);
      } catch (error) {
        unfinished = true;
        this.logger.error(`Night audit branch ${branchId}: a batch of ${batchIds.length} no-shows failed`, error);
        for (const id of batchIds) errors.push({ reservationId: id, reason: `Not marked this run, run it again: ${reasonOf(error)}` });
      }
    }
    return { marked, unfinished };
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
      // Oldest first, so a night the sweep missed is closed before yesterday's,
      // and a later night that was somehow closed ahead of these is named.
      const pendingDates = await this.datesToAuditInTx(tx, branchId, branch.timezone);
      const closedAhead =
        pendingDates.length > 0
          ? (
              await tx.nightAuditLog.findMany({
                where: { branchId, status: 'completed', auditDate: { gt: toBranchDate(pendingDates[0]) } },
                select: { auditDate: true },
                orderBy: { auditDate: 'asc' },
              })
            ).map((run) => run.auditDate.toISOString().slice(0, 10))
          : [];
      // The next night to close, if its last run failed or died part-way — said
      // on the page, so a stopped audit is never a silent one.
      const stopped =
        pendingDates.length > 0
          ? await tx.nightAuditLog.findFirst({ where: { branchId, auditDate: toBranchDate(pendingDates[0]), status: { in: ['failed', 'running'] } } })
          : null;
      const stoppedErrors = ((stopped?.errors ?? []) as RunError[]).filter((e) => typeof e?.reason === 'string');
      // A reason about the run itself (a lost connection, a batch cut off) before any one stay's.
      const stoppedReason = (stoppedErrors.find((e) => e.reason.startsWith('The run stopped') || e.reason.startsWith('Not ')) ?? stoppedErrors[0])?.reason;

      return {
        auditDate: pendingDates[0] ?? auditDate,
        alreadyRan: pendingDates.length === 0 && alreadyRan !== null,
        /** Every night still to close, oldest first — what the Trigger Audit button runs through. */
        pendingDates,
        /** Nights already closed that come AFTER the oldest pending one — closed out of order, worth a look. */
        closedAhead,
        /** The oldest pending night's last run, when it failed or was cut off — running it again carries on where it stopped. */
        lastStoppedRun: stopped
          ? {
              auditDate: stopped.auditDate.toISOString().slice(0, 10),
              status: stopped.status,
              chargesPosted: stopped.chargesPosted ?? 0,
              errorCount: stoppedErrors.length,
              reason: stoppedReason ?? (stopped.status === 'running' ? 'It stopped part-way — the server restarted or lost the database.' : null),
            }
          : null,
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
    return this.prisma.withTenant(tenantId, (tx) => this.datesToAuditInTx(tx, branchId, timezone));
  }

  private async datesToAuditInTx(tx: TenantTx, branchId: string, timezone: string): Promise<string[]> {
    const yesterday = toBranchDate(this.yesterdayForBranch(timezone));
    const earliest = new Date(yesterday);
    earliest.setUTCDate(earliest.getUTCDate() - (CATCH_UP_DAYS - 1));
    // Closed, or being closed right now. A failed run, or one that died
    // part-way and went stale, leaves its night pending — run again, it
    // carries on where it stopped.
    const done = await tx.nightAuditLog.findMany({
      where: {
        branchId,
        auditDate: { gte: earliest, lte: yesterday },
        OR: [{ status: 'completed' }, { status: 'running', triggeredAt: { gte: new Date(Date.now() - STALE_RUN_MS) } }],
      },
      select: { auditDate: true },
    });
    const doneDates = new Set(done.map((run) => run.auditDate.toISOString().slice(0, 10)));
    const latest = await tx.nightAuditLog.findFirst({ where: { branchId }, orderBy: { auditDate: 'desc' }, select: { auditDate: true } });
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
            if (result.status === 'failed') {
              // Nights close in order: a later one waits until this one is
              // through. The next sweep carries on where this run stopped, and
              // the Night Audit page says it stopped.
              this.logger.error(`Night audit failed: branch ${branch.id} date ${auditDate} — ${result.errors.length} error(s); retried next hour`);
              break;
            }
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
