import { Injectable } from '@nestjs/common';
import { hasPassedBranchCutoff, timeOfDay, toBranchDate, todayInTimezone } from '../../common/utils/branch-date';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { FoliosService } from '../folios/folios.service';

/** Just enough to render and link an alert row — not the full `RESERVATION_INCLUDE` (`ReservationsService`'s own shape), which carries rate-plan/no-show fields no alert row needs. */
const ALERT_RESERVATION_SELECT = {
  id: true,
  confirmationNumber: true,
  checkInDate: true,
  checkOutDate: true,
  guest: { select: { id: true, name: true, phone: true } },
  roomType: { select: { name: true } },
  room: { select: { number: true } },
} as const;

/**
 * Mirrors the in-house PMS's own Alerts design (one service, a handful of
 * independent branch-scoped queries computed live on every request,
 * aggregated into one response — no stored Alert/Notification row, no
 * severity or dismissal state, self-resolving the instant the real
 * underlying record changes) with one deliberate improvement: Roomick
 * already models a real per-branch check-in/check-out clock time and IANA
 * timezone (`Branch.checkInTime`/`checkOutTime`/`timezone`), so "has this
 * actually become overdue yet" uses that directly instead of the
 * reference's own hardcoded noon-Lagos-only assumption (this codebase's
 * hotels are not all in one country).
 *
 * Only three categories exist here, not the reference's four — Roomick's
 * booking lifecycle has no "unconfirmed/pending-payment hold" status
 * (`ReservationStatus` has no `hold` value), so that category has no real
 * equivalent to port.
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    private readonly foliosService: FoliosService,
  ) {}

  async getAlerts(tenantId: string, branchId: string) {
    const [reservationAlerts, overdueBalances] = await Promise.all([
      this.getReservationAlerts(tenantId, branchId),
      // Reuses FoliosService's own existing "overdue" filter — a checked-out
      // guest still owing money, the City Ledger case `PMS-OPERATIONS-
      // GUIDE.md:221` names — rather than re-deriving a second copy of the
      // same balance computation here.
      this.foliosService.listFolios(tenantId, branchId, 'overdue'),
    ]);

    return {
      missedCheckIns: reservationAlerts.missedCheckIns,
      overdueCheckouts: reservationAlerts.overdueCheckouts,
      overdueBalances,
      total: reservationAlerts.missedCheckIns.length + reservationAlerts.overdueCheckouts.length + overdueBalances.length,
    };
  }

  /**
   * `withTenant` on its own, separate from `getAlerts`'s own `Promise.all` —
   * `FoliosService.listFolios` opens its own transaction, and this codebase
   * never nests one service's `withTenant` inside another's (cross-service
   * calls INSIDE a transaction go through an `xxxInTx(tx, ...)` sibling
   * instead, which `listFolios` doesn't have here since it isn't called
   * from inside any other service's transaction elsewhere either).
   */
  private async getReservationAlerts(tenantId: string, branchId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const now = new Date();
      const today = toBranchDate(todayInTimezone(branch.timezone));
      const checkInCutoff = timeOfDay(branch.checkInTime);
      const checkOutCutoff = timeOfDay(branch.checkOutTime);

      const [missedCandidates, overdueCandidates] = await Promise.all([
        tx.reservation.findMany({
          where: { branchId, deletedAt: null, status: 'confirmed', checkInDate: { lte: today } },
          select: ALERT_RESERVATION_SELECT,
          orderBy: { checkInDate: 'asc' },
        }),
        tx.reservation.findMany({
          where: { branchId, deletedAt: null, status: 'checked_in', checkOutDate: { lte: today } },
          select: ALERT_RESERVATION_SELECT,
          orderBy: { checkOutDate: 'asc' },
        }),
      ]);

      // The SQL `<= today` above is a cheap, index-friendly pre-filter only
      // — a reservation due exactly today isn't actually missed/overdue
      // until the branch's own posted check-in/check-out clock time has
      // passed (see `hasPassedBranchCutoff`'s own comment); anything
      // strictly before today is unambiguously overdue regardless of clock
      // time, and this same filter correctly includes those too.
      return {
        missedCheckIns: missedCandidates.filter((r) => hasPassedBranchCutoff(r.checkInDate, checkInCutoff, branch.timezone, now)),
        overdueCheckouts: overdueCandidates.filter((r) => hasPassedBranchCutoff(r.checkOutDate, checkOutCutoff, branch.timezone, now)),
      };
    });
  }
}
