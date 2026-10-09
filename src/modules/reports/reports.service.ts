import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { branchDayStart, localDateOf, toBranchDate, todayInTimezone } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { ReportGroupBy, ReportQueryDto } from './dto/report-query.dto';
import { renderReportPdf } from './report-pdf.util';

/** The widest range one report request may cover. */
export const MAX_REPORT_DAYS = 366;

const ZERO = new Prisma.Decimal(0);

/**
 * Reservation statuses that represent a room-night actually sold, for
 * REPORTING purposes — deliberately wider than `HOLDING_STATUSES`
 * (`ReservationsService`'s own availability-gate set), which only cares
 * about inventory currently held. A report over a past date range must
 * still count nights from stays that have since checked out — those nights
 * genuinely happened and sold real inventory, even though the reservation
 * itself no longer holds anything today.
 */
const SOLD_STATUSES = ['confirmed', 'checked_in', 'checked_out'] as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** How old a receivable is, by days since it was billed. */
export const AGEING_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export function ageingBucket(days: number): AgeingBucket {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

export interface ArAgeingBill {
  folioId: string;
  label: string | null;
  guestName: string;
  confirmationNumber: string | null;
  /** The newest invoice for the bill, if it has been invoiced. */
  invoice: { number: string; issuedOn: string; dueDate: string | null } | null;
  /** The day the age counts from: the invoice, else the day the stay ended, else the day the bill was opened. */
  since: string;
  ageDays: number;
  bucket: AgeingBucket;
  /** Past the invoice's due date. */
  overdue: boolean;
  balance: string;
}

export interface ArAgeingDebtor {
  key: string;
  type: 'company' | 'guest';
  name: string;
  buckets: Record<AgeingBucket, string>;
  total: string;
  bills: ArAgeingBill[];
}

export interface ArAgeingReport {
  asOf: string;
  currency: string;
  buckets: readonly AgeingBucket[];
  debtors: ArAgeingDebtor[];
  totals: Record<AgeingBucket, string> & { total: string };
}

interface RoomNightBucket {
  available: number;
  sold: number;
  revenue: Prisma.Decimal;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
  ) {}

  private isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /**
   * Accounts receivable ageing: every bill at the property that a guest who
   * has left — or a company — still owes on, grouped by who owes it, and
   * aged into 0–30, 31–60, 61–90 and 90+ days. A bill's age counts from its
   * latest invoice, else the day the stay ended (check-out), else the day the
   * bill was opened (a no-show or cancellation charge). Guests still in the
   * house aren't receivables yet; deposits and credits aren't either.
   */
  async getArAgeing(tenantId: string, branchId: string, asOfDay?: string): Promise<ArAgeingReport> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const asOf = asOfDay ?? todayInTimezone(branch.timezone);
      const asOfDate = toBranchDate(asOf);
      const folios = await tx.folio.findMany({
        where: { branchId, deletedAt: null, status: { not: 'settled' }, reservation: { is: { status: { in: ['checked_out', 'no_show', 'cancelled'] } } } },
        select: {
          id: true,
          label: true,
          payerName: true,
          createdAt: true,
          guest: { select: { id: true, name: true } },
          corporateAccount: { select: { id: true, name: true } },
          reservation: { select: { confirmationNumber: true, actualCheckOut: true } },
          invoices: { where: { supersededAt: null }, orderBy: { issuedAt: 'desc' }, take: 1, select: { number: true, issuedAt: true, dueDate: true } },
        },
      });
      const ids = folios.map((f) => f.id);
      const [charges, payments] = ids.length
        ? await Promise.all([
            tx.lineItem.groupBy({ by: ['folioId'], where: { folioId: { in: ids }, isVoid: false, deletedAt: null }, _sum: { amount: true } }),
            tx.payment.groupBy({ by: ['folioId'], where: { folioId: { in: ids }, isVoid: false, deletedAt: null }, _sum: { amount: true } }),
          ])
        : [[], []];
      const balance = new Map<string, Prisma.Decimal>();
      for (const row of charges) balance.set(row.folioId, (balance.get(row.folioId) ?? ZERO).plus(row._sum.amount ?? ZERO));
      for (const row of payments) balance.set(row.folioId, (balance.get(row.folioId) ?? ZERO).minus(row._sum.amount ?? ZERO));

      const emptyBuckets = (): Record<AgeingBucket, Prisma.Decimal> => ({ '0-30': ZERO, '31-60': ZERO, '61-90': ZERO, '90+': ZERO });
      const debtors = new Map<string, { type: 'company' | 'guest'; name: string; buckets: Record<AgeingBucket, Prisma.Decimal>; total: Prisma.Decimal; bills: ArAgeingBill[] }>();
      const totals = emptyBuckets();
      for (const folio of folios) {
        const owed = balance.get(folio.id) ?? ZERO;
        if (!owed.greaterThan(0)) continue;
        const invoice = folio.invoices[0] ?? null;
        const since = invoice
          ? localDateOf(invoice.issuedAt, branch.timezone)
          : localDateOf(folio.reservation?.actualCheckOut ?? folio.createdAt, branch.timezone);
        const ageDays = Math.max(0, Math.round((asOfDate.getTime() - toBranchDate(since).getTime()) / 86_400_000));
        const bucket = ageingBucket(ageDays);
        const company = folio.corporateAccount;
        const key = company ? `company:${company.id}` : `guest:${folio.guest.id}`;
        const debtor = debtors.get(key) ?? { type: company ? ('company' as const) : ('guest' as const), name: company?.name ?? folio.payerName ?? folio.guest.name, buckets: emptyBuckets(), total: ZERO, bills: [] };
        debtor.buckets[bucket] = debtor.buckets[bucket].plus(owed);
        debtor.total = debtor.total.plus(owed);
        totals[bucket] = totals[bucket].plus(owed);
        const dueDate = invoice?.dueDate ? this.isoDate(invoice.dueDate) : null;
        debtor.bills.push({
          folioId: folio.id,
          label: folio.label,
          guestName: folio.guest.name,
          confirmationNumber: folio.reservation?.confirmationNumber ?? null,
          invoice: invoice ? { number: invoice.number, issuedOn: localDateOf(invoice.issuedAt, branch.timezone), dueDate } : null,
          since,
          ageDays,
          bucket,
          overdue: dueDate !== null && dueDate < asOf,
          balance: owed.toFixed(2),
        });
        debtors.set(key, debtor);
      }

      const fixed = (buckets: Record<AgeingBucket, Prisma.Decimal>) =>
        Object.fromEntries(AGEING_BUCKETS.map((b) => [b, buckets[b].toFixed(2)])) as Record<AgeingBucket, string>;
      const grand = AGEING_BUCKETS.reduce((sum, b) => sum.plus(totals[b]), ZERO);
      return {
        asOf,
        currency: branch.currency,
        buckets: AGEING_BUCKETS,
        debtors: [...debtors.entries()]
          .sort(([, a], [, b]) => b.total.comparedTo(a.total))
          .map(([key, d]) => ({ key, type: d.type, name: d.name, buckets: fixed(d.buckets), total: d.total.toFixed(2), bills: d.bills.sort((x, y) => y.ageDays - x.ageDays) })),
        totals: { ...fixed(totals), total: grand.toFixed(2) },
      };
    });
  }

  /**
   * Every report expands its range night by night in memory, so a year is
   * the most one request may ask for — "2020 to today" on a 200-room
   * property was a multi-second request anyone with the page could repeat.
   */
  range(dto: Pick<ReportQueryDto, 'from' | 'to'>, maxDays = MAX_REPORT_DAYS): { from: Date; to: Date } {
    const from = toBranchDate(dto.from);
    const to = toBranchDate(dto.to);
    // `to` is exclusive, so an equal pair is an empty range: it reports nothing, which is what a
    // branch created today has to say about its history (the demand forecast relies on that).
    if (to < from) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: "The end of the range can't be before its start" });
    }
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
    if (days > maxDays) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `A report covers at most ${maxDays} days at a time — narrow the dates` });
    }
    return { from, to };
  }

  private enumerateDays(from: Date, to: Date): Date[] {
    const days: Date[] = [];
    for (let d = new Date(from); d < to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))) {
      days.push(new Date(d));
    }
    return days;
  }

  /** "day" is the row itself; "week" buckets in fixed 7-day windows from the range's own start (not ISO week numbers — simpler, and a report's own date range is the only thing that needs to agree with itself); "month" is the calendar month, the standard grouping for occupancy/revenue in hotel reporting. */
  private periodKeyFor(date: Date, groupBy: ReportGroupBy, rangeStart: Date): string {
    if (groupBy === 'month') return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    if (groupBy === 'week') {
      const daysSinceStart = Math.floor((date.getTime() - rangeStart.getTime()) / 86_400_000);
      const weekStart = new Date(rangeStart.getTime() + Math.floor(daysSinceStart / 7) * 7 * 86_400_000);
      return this.isoDate(weekStart);
    }
    return this.isoDate(date);
  }

  /**
   * Shared core for occupancy/ADR/RevPAR — one pass over room pool,
   * overlapping reservations, and posted room revenue, sliced three
   * different ways by the public methods below rather than three separate
   * near-identical queries against the same underlying data.
   */
  private async roomNightMetrics(tx: TenantTx, branchId: string, timezone: string, from: Date, to: Date, roomTypeId?: string) {
    const roomTypes = await tx.roomType.findMany({
      where: { branchId, deletedAt: null, ...(roomTypeId ? { id: roomTypeId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    const poolByType = new Map<string, number>();
    for (const rt of roomTypes) {
      poolByType.set(rt.id, await tx.room.count({ where: { branchId, roomTypeId: rt.id, deletedAt: null } }));
    }

    // Day use sells the room for the day, not a night: it is neither a night
    // sold nor room-night revenue (it's in the revenue reports as room revenue).
    const reservations = await tx.reservation.findMany({
      where: {
        branchId,
        deletedAt: null,
        isDayUse: false,
        status: { in: [...SOLD_STATUSES] },
        checkInDate: { lt: to },
        // A guest still in, or who left after their date, can hold nights
        // past the departure they booked. Filtered by room type below, night
        // by night: a stay moved between types counts under each in turn.
        OR: [{ checkOutDate: { gt: from } }, { status: 'checked_in' }, { status: 'checked_out', actualCheckOut: { gte: from } }],
      },
      select: { id: true, roomTypeId: true, checkInDate: true, checkOutDate: true, status: true, actualCheckOut: true },
    });

    // Each night billed knows the room type it was sold as (`LineItem.roomTypeId`;
    // older nights, the stay's own type). A room move or a transfer to another
    // guest's bill no longer re-files a night under someone else's type.
    const roomRevenueRows = await tx.lineItem.findMany({
      where: {
        folio: { branchId },
        // A night's correction counts against it — otherwise a reversed night
        // would still be room revenue (the correction row is `correction`,
        // not `room`).
        OR: [{ chargeType: 'room', dayUse: false }, { chargeType: 'correction', correctsLineItem: { chargeType: 'room', dayUse: false } }],
        isVoid: false,
        deletedAt: null,
        serviceDate: { gte: from, lt: to },
      },
      select: {
        amount: true,
        serviceDate: true,
        chargeType: true,
        roomTypeId: true,
        stayReservationId: true,
        stayReservation: { select: { roomTypeId: true } },
        folio: { select: { reservation: { select: { roomTypeId: true } } } },
        correctsLineItem: { select: { roomTypeId: true, stayReservationId: true, stayReservation: { select: { roomTypeId: true } } } },
      },
    });
    type RevenueRow = (typeof roomRevenueRows)[number];
    const soldAs = (row: RevenueRow): string | null => {
      const night = row.correctsLineItem ?? row;
      return night.roomTypeId ?? night.stayReservation?.roomTypeId ?? row.folio.reservation?.roomTypeId ?? null;
    };
    // The room type each billed night of each stay was sold as.
    const nightType = new Map<string, string>();
    for (const row of roomRevenueRows) {
      if (row.chargeType !== 'room' || !row.stayReservationId || !row.serviceDate || !row.roomTypeId) continue;
      nightType.set(`${row.stayReservationId}|${this.isoDate(row.serviceDate)}`, row.roomTypeId);
    }

    const days = this.enumerateDays(from, to);
    const buckets = new Map<string, RoomNightBucket>(); // key: `${isoDate}|${roomTypeId}`

    for (const day of days) {
      const dateStr = this.isoDate(day);
      for (const rt of roomTypes) {
        buckets.set(`${dateStr}|${rt.id}`, { available: poolByType.get(rt.id) ?? 0, sold: 0, revenue: ZERO });
      }
    }
    // From the branch's own today: UTC's is a different date for part of every day.
    const branchToday = toBranchDate(todayInTimezone(timezone));
    for (const r of reservations) {
      // The nights the room was really taken. A guest who left early used it
      // up to the day they left — the nights after went back on sale, and
      // counting them too put a resold room in the figures twice (occupancy
      // over 100%). One who stayed on past their date held it every night
      // they were there, as availability and the night audit already count.
      let until = r.checkOutDate;
      if (r.status === 'checked_out' && r.actualCheckOut) {
        const leftOn = toBranchDate(localDateOf(r.actualCheckOut, timezone));
        const firstNightAfter = new Date(r.checkInDate.getTime() + 86_400_000);
        until = leftOn > firstNightAfter ? leftOn : firstNightAfter;
      } else if (r.status === 'checked_in' && r.checkOutDate <= branchToday) {
        until = new Date(branchToday.getTime() + 86_400_000);
      }
      for (const day of days) {
        if (day >= r.checkInDate && day < until) {
          const type = nightType.get(`${r.id}|${this.isoDate(day)}`) ?? r.roomTypeId;
          if (roomTypeId && type !== roomTypeId) continue;
          const bucket = buckets.get(`${this.isoDate(day)}|${type}`);
          if (bucket) bucket.sold += 1;
        }
      }
    }
    // A room blocked out of service isn't available to sell, so its nights
    // come off the denominator — occupancy used to count them as empty rooms.
    // Dated blocks cover the past; a room held out of order right now, with
    // no end date, counts from today forward.
    const blocks = await tx.roomBlock.findMany({
      where: { room: { branchId, deletedAt: null, ...(roomTypeId ? { roomTypeId } : {}) }, fromDate: { lt: to }, toDate: { gte: from } },
      select: { fromDate: true, toDate: true, room: { select: { roomTypeId: true } } },
    });
    for (const block of blocks) {
      for (const day of days) {
        if (day >= block.fromDate && day <= block.toDate) {
          const bucket = buckets.get(`${this.isoDate(day)}|${block.room.roomTypeId}`);
          if (bucket && bucket.available > 0) bucket.available -= 1;
        }
      }
    }
    const heldNow = await tx.room.findMany({
      where: { branchId, deletedAt: null, heldStatus: 'out_of_order', ...(roomTypeId ? { roomTypeId } : {}) },
      select: { roomTypeId: true },
    });
    for (const room of heldNow) {
      for (const day of days) {
        if (day >= branchToday) {
          const bucket = buckets.get(`${this.isoDate(day)}|${room.roomTypeId}`);
          if (bucket && bucket.available > 0) bucket.available -= 1;
        }
      }
    }
    for (const row of roomRevenueRows) {
      const rtId = soldAs(row);
      if (!rtId || !row.serviceDate) continue;
      if (roomTypeId && rtId !== roomTypeId) continue;
      const bucket = buckets.get(`${this.isoDate(row.serviceDate)}|${rtId}`);
      if (bucket) bucket.revenue = bucket.revenue.plus(row.amount);
    }

    return { roomTypes, days, buckets };
  }

  private sumBucket(buckets: Map<string, RoomNightBucket>, dateStr: string, roomTypeId: string): RoomNightBucket {
    return buckets.get(`${dateStr}|${roomTypeId}`) ?? { available: 0, sold: 0, revenue: ZERO };
  }

  private sumDayAcrossRoomTypes(buckets: Map<string, RoomNightBucket>, dateStr: string, roomTypeIds: string[]): RoomNightBucket {
    let available = 0;
    let sold = 0;
    let revenue = ZERO;
    for (const id of roomTypeIds) {
      const b = this.sumBucket(buckets, dateStr, id);
      available += b.available;
      sold += b.sold;
      revenue = revenue.plus(b.revenue);
    }
    return { available, sold, revenue };
  }

  async getOccupancy(tenantId: string, branchId: string, dto: ReportQueryDto) {
    const { from, to } = this.range(dto);
    const groupBy = dto.groupBy ?? 'day';
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const { roomTypes, days, buckets } = await this.roomNightMetrics(tx, branchId, branch.timezone, from, to, dto.roomTypeId);
      const roomTypeIds = roomTypes.map((rt) => rt.id);

      const byRoomType = roomTypes.map((rt) => {
        let available = 0;
        let sold = 0;
        for (const day of days) {
          const b = this.sumBucket(buckets, this.isoDate(day), rt.id);
          available += b.available;
          sold += b.sold;
        }
        return { roomTypeId: rt.id, roomTypeName: rt.name, roomNightsAvailable: available, roomNightsSold: sold, occupancyPct: available > 0 ? round2((sold / available) * 100) : 0 };
      });

      const trendMap = new Map<string, { available: number; sold: number }>();
      for (const day of days) {
        const key = this.periodKeyFor(day, groupBy, from);
        const daySum = this.sumDayAcrossRoomTypes(buckets, this.isoDate(day), roomTypeIds);
        const entry = trendMap.get(key) ?? { available: 0, sold: 0 };
        entry.available += daySum.available;
        entry.sold += daySum.sold;
        trendMap.set(key, entry);
      }
      const trend = [...trendMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, { available, sold }]) => ({ period, roomNightsAvailable: available, roomNightsSold: sold, occupancyPct: available > 0 ? round2((sold / available) * 100) : 0 }));

      const totalAvailable = byRoomType.reduce((s, r) => s + r.roomNightsAvailable, 0);
      const totalSold = byRoomType.reduce((s, r) => s + r.roomNightsSold, 0);

      return {
        from: dto.from,
        to: dto.to,
        groupBy,
        summary: { roomNightsAvailable: totalAvailable, roomNightsSold: totalSold, occupancyPct: totalAvailable > 0 ? round2((totalSold / totalAvailable) * 100) : 0 },
        byRoomType,
        trend,
      };
    });
  }

  async getAdr(tenantId: string, branchId: string, dto: ReportQueryDto) {
    const { from, to } = this.range(dto);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const { roomTypes, days, buckets } = await this.roomNightMetrics(tx, branchId, branch.timezone, from, to, dto.roomTypeId);
      const roomTypeIds = roomTypes.map((rt) => rt.id);

      const byRoomType = roomTypes.map((rt) => {
        let sold = 0;
        let revenue = ZERO;
        for (const day of days) {
          const b = this.sumBucket(buckets, this.isoDate(day), rt.id);
          sold += b.sold;
          revenue = revenue.plus(b.revenue);
        }
        return { roomTypeId: rt.id, roomTypeName: rt.name, roomNightsSold: sold, roomRevenue: revenue.toFixed(2), adr: sold > 0 ? revenue.div(sold).toFixed(2) : '0.00' };
      });

      const trend = days.map((day) => {
        const b = this.sumDayAcrossRoomTypes(buckets, this.isoDate(day), roomTypeIds);
        return { period: this.isoDate(day), roomNightsSold: b.sold, roomRevenue: b.revenue.toFixed(2), adr: b.sold > 0 ? b.revenue.div(b.sold).toFixed(2) : '0.00' };
      });

      const totalSold = byRoomType.reduce((s, r) => s + r.roomNightsSold, 0);
      const totalRevenue = byRoomType.reduce((s, r) => s.plus(r.roomRevenue), ZERO);

      return {
        from: dto.from,
        to: dto.to,
        currency: branch.currency,
        summary: { roomNightsSold: totalSold, roomRevenue: totalRevenue.toFixed(2), adr: totalSold > 0 ? totalRevenue.div(totalSold).toFixed(2) : '0.00' },
        byRoomType,
        trend,
      };
    });
  }

  async getRevpar(tenantId: string, branchId: string, dto: ReportQueryDto) {
    const { from, to } = this.range(dto);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const { roomTypes, days, buckets } = await this.roomNightMetrics(tx, branchId, branch.timezone, from, to, dto.roomTypeId);
      const roomTypeIds = roomTypes.map((rt) => rt.id);

      const byRoomType = roomTypes.map((rt) => {
        let available = 0;
        let revenue = ZERO;
        for (const day of days) {
          const b = this.sumBucket(buckets, this.isoDate(day), rt.id);
          available += b.available;
          revenue = revenue.plus(b.revenue);
        }
        return { roomTypeId: rt.id, roomTypeName: rt.name, roomNightsAvailable: available, roomRevenue: revenue.toFixed(2), revpar: available > 0 ? revenue.div(available).toFixed(2) : '0.00' };
      });

      const trend = days.map((day) => {
        const b = this.sumDayAcrossRoomTypes(buckets, this.isoDate(day), roomTypeIds);
        return { period: this.isoDate(day), roomNightsAvailable: b.available, roomRevenue: b.revenue.toFixed(2), revpar: b.available > 0 ? b.revenue.div(b.available).toFixed(2) : '0.00' };
      });

      const totalAvailable = byRoomType.reduce((s, r) => s + r.roomNightsAvailable, 0);
      const totalRevenue = byRoomType.reduce((s, r) => s.plus(r.roomRevenue), ZERO);

      return {
        from: dto.from,
        to: dto.to,
        currency: branch.currency,
        summary: { roomNightsAvailable: totalAvailable, roomRevenue: totalRevenue.toFixed(2), revpar: totalAvailable > 0 ? totalRevenue.div(totalAvailable).toFixed(2) : '0.00' },
        byRoomType,
        trend,
      };
    });
  }

  /**
   * Revenue by department and by payment method, plus a day-level trend.
   * Department is `LineItem.chargeType`, tax excluded (collected for the
   * state, not earned). A correction counts against the department of the
   * line it reverses (`correctsLineItemId`), so a reversed charge nets out
   * instead of staying in revenue; one with no link (posted before the link
   * existed, or a no-show waiver) stays its own `correction` row, so the
   * total still nets it. Walk-in Point of Sale sales — cash or card, never
   * on a folio — come from `pos_orders`: pre-tax under the outlet's charge
   * type, as paid under their payment method. A room-charged sale is already
   * a folio line, so it isn't counted twice.
   * `groupBy=department` in the reference's own querystring is really just
   * naming which breakdown the UI leads with — this always returns both.
   */
  async getRevenue(tenantId: string, branchId: string, dto: ReportQueryDto) {
    const { from, to } = this.range(dto);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);

      const lineItems = await tx.lineItem.findMany({
        where: {
          folio: { branchId },
          isVoid: false,
          deletedAt: null,
          chargeType: { not: 'tax' },
          serviceDate: { gte: from, lt: to },
        },
        select: { amount: true, chargeType: true, serviceDate: true, correctsLineItem: { select: { chargeType: true } } },
      });
      // Payments and walk-in sales are moments, not service dates, so the
      // range is the branch's own days: midnight to midnight in its timezone.
      // UTC midnight here filed a Lagos payment taken at 00:30 under the day
      // before (and the accounting export groups by the same local day).
      const momentsFrom = branchDayStart(dto.from, branch.timezone);
      const momentsTo = branchDayStart(dto.to, branch.timezone);
      const payments = await tx.payment.findMany({
        where: { folio: { branchId }, isVoid: false, deletedAt: null, recordedAt: { gte: momentsFrom, lt: momentsTo } },
        select: { amount: true, method: true },
      });
      // Sales paid at the outlet (cash, card or both) — a room charge is on the folio, counted above.
      const posSales = await tx.posOrder.findMany({
        where: { branchId, settlement: { not: 'room' }, voidedAt: null, createdAt: { gte: momentsFrom, lt: momentsTo } },
        select: { subtotal: true, total: true, cashAmount: true, cardAmount: true, createdAt: true, outlet: { select: { chargeType: true } } },
      });

      const add = (map: Map<string, Prisma.Decimal>, key: string, amount: Prisma.Decimal) => map.set(key, (map.get(key) ?? ZERO).plus(amount));
      const byDepartment = new Map<string, Prisma.Decimal>();
      const byPaymentMethod = new Map<string, Prisma.Decimal>();
      const trendMap = new Map<string, Prisma.Decimal>();

      for (const li of lineItems) {
        add(byDepartment, li.correctsLineItem?.chargeType ?? li.chargeType, li.amount);
        if (li.serviceDate) add(trendMap, this.isoDate(li.serviceDate), li.amount);
      }
      for (const p of payments) add(byPaymentMethod, p.method, p.amount);
      for (const sale of posSales) {
        add(byDepartment, sale.outlet.chargeType, sale.subtotal);
        if (sale.cashAmount.greaterThan(0)) add(byPaymentMethod, 'cash', sale.cashAmount);
        if (sale.cardAmount.greaterThan(0)) add(byPaymentMethod, 'card', sale.cardAmount);
        add(trendMap, localDateOf(sale.createdAt, branch.timezone), sale.subtotal);
      }
      const totalRevenue = [...byDepartment.values()].reduce((s, v) => s.plus(v), ZERO);
      const trend = [...trendMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, amount]) => ({ period, amount: amount.toFixed(2) }));

      return {
        from: dto.from,
        to: dto.to,
        currency: branch.currency,
        summary: { totalRevenue: totalRevenue.toFixed(2) },
        byDepartment: [...byDepartment.entries()].map(([chargeType, amount]) => ({ chargeType, amount: amount.toFixed(2) })),
        byPaymentMethod: [...byPaymentMethod.entries()].map(([method, amount]) => ({ method, amount: amount.toFixed(2) })),
        trend,
      };
    });
  }

  /**
   * Financial Reports (ref: "Daily revenue, tax, cash flow, monthly summary"
   * — revenue by department, tax breakdown, cash flow, payment methods) for
   * the accountant: what was earned and taxed per period, and what money
   * came in and went back out.
   *
   * - **Revenue** is the same as the Revenue report's: folio charges by
   *   service date, by department, tax excluded, corrections against the
   *   department they reverse; walk-in Point of Sale sales by the day they
   *   were rung up.
   * - **Tax** is every tax line by service date, by rule, with the taxable
   *   base worked out the way a bill's Tax Breakdown does; walk-in Point of
   *   Sale tax is one row of its own (a sale stores its tax total, not each
   *   rule's share).
   * - **Money in / back** is payments by the branch's own day — positive in,
   *   negative (refunds, a walk's reversal) back out — and walk-in sales.
   *   Loyalty points aren't money and are left out.
   */
  async getFinancial(tenantId: string, branchId: string, dto: ReportQueryDto) {
    const { from, to } = this.range(dto);
    const groupBy: ReportGroupBy = dto.groupBy ?? 'day';
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const momentsFrom = branchDayStart(dto.from, branch.timezone);
      const momentsTo = branchDayStart(dto.to, branch.timezone);

      const [lineItems, payments, posSales, rules] = await Promise.all([
        tx.lineItem.findMany({
          where: { folio: { branchId }, isVoid: false, deletedAt: null, serviceDate: { gte: from, lt: to } },
          select: { amount: true, chargeType: true, serviceDate: true, taxRuleIds: true, parentLineItemId: true, correctsLineItem: { select: { chargeType: true } } },
        }),
        tx.payment.findMany({
          where: { folio: { branchId }, isVoid: false, deletedAt: null, recordedAt: { gte: momentsFrom, lt: momentsTo }, method: { not: 'loyalty_points' } },
          select: { amount: true, method: true, recordedAt: true },
        }),
        tx.posOrder.findMany({
          where: { branchId, settlement: { not: 'room' }, voidedAt: null, createdAt: { gte: momentsFrom, lt: momentsTo } },
          select: { subtotal: true, taxTotal: true, total: true, cashAmount: true, cardAmount: true, createdAt: true, outlet: { select: { chargeType: true } } },
        }),
        tx.taxRule.findMany({ where: { branchId } }),
      ]);

      type Period = { departments: Map<string, Prisma.Decimal>; revenue: Prisma.Decimal; tax: Prisma.Decimal; moneyIn: Prisma.Decimal; moneyBack: Prisma.Decimal };
      const periods = new Map<string, Period>();
      for (const day of this.enumerateDays(from, to)) {
        const key = this.periodKeyFor(day, groupBy, from);
        if (!periods.has(key)) periods.set(key, { departments: new Map(), revenue: ZERO, tax: ZERO, moneyIn: ZERO, moneyBack: ZERO });
      }
      const periodOf = (date: Date) => periods.get(this.periodKeyFor(date, groupBy, from));
      const departments = new Set<string>();
      const taxByRule = new Map<string, Prisma.Decimal>();
      const fixedBaseByRule = new Map<string, Prisma.Decimal>();
      const methods = new Map<string, { moneyIn: Prisma.Decimal; moneyBack: Prisma.Decimal }>();
      let posTax = ZERO;

      // Fixed-rule bases are the charges themselves — the parent of each of its tax lines.
      const parentIds = [...new Set(lineItems.filter((li) => li.chargeType === 'tax' && li.parentLineItemId).map((li) => li.parentLineItemId as string))];
      const parents = parentIds.length ? await tx.lineItem.findMany({ where: { id: { in: parentIds } }, select: { id: true, amount: true } }) : [];
      const parentAmount = new Map(parents.map((p) => [p.id, p.amount]));

      for (const li of lineItems) {
        const period = li.serviceDate ? periodOf(li.serviceDate) : undefined;
        if (!period) continue;
        if (li.chargeType === 'tax') {
          period.tax = period.tax.plus(li.amount);
          const ruleId = li.taxRuleIds[0];
          if (ruleId) {
            taxByRule.set(ruleId, (taxByRule.get(ruleId) ?? ZERO).plus(li.amount));
            const base = li.parentLineItemId ? parentAmount.get(li.parentLineItemId) : undefined;
            if (base) fixedBaseByRule.set(ruleId, (fixedBaseByRule.get(ruleId) ?? ZERO).plus(base));
          }
          continue;
        }
        const department = li.correctsLineItem?.chargeType ?? li.chargeType;
        departments.add(department);
        period.departments.set(department, (period.departments.get(department) ?? ZERO).plus(li.amount));
        period.revenue = period.revenue.plus(li.amount);
      }

      const method = (name: string) => {
        const entry = methods.get(name) ?? { moneyIn: ZERO, moneyBack: ZERO };
        methods.set(name, entry);
        return entry;
      };
      for (const sale of posSales) {
        const period = periodOf(toBranchDate(localDateOf(sale.createdAt, branch.timezone)));
        if (!period) continue;
        const department = sale.outlet.chargeType;
        departments.add(department);
        period.departments.set(department, (period.departments.get(department) ?? ZERO).plus(sale.subtotal));
        period.revenue = period.revenue.plus(sale.subtotal);
        period.tax = period.tax.plus(sale.taxTotal);
        posTax = posTax.plus(sale.taxTotal);
        period.moneyIn = period.moneyIn.plus(sale.total);
        if (sale.cashAmount.greaterThan(0)) method('cash').moneyIn = method('cash').moneyIn.plus(sale.cashAmount);
        if (sale.cardAmount.greaterThan(0)) method('card').moneyIn = method('card').moneyIn.plus(sale.cardAmount);
      }
      for (const payment of payments) {
        const period = periodOf(toBranchDate(localDateOf(payment.recordedAt, branch.timezone)));
        if (!period) continue;
        if (payment.amount.greaterThan(0)) {
          period.moneyIn = period.moneyIn.plus(payment.amount);
          method(payment.method).moneyIn = method(payment.method).moneyIn.plus(payment.amount);
        } else {
          period.moneyBack = period.moneyBack.plus(payment.amount.negated());
          method(payment.method).moneyBack = method(payment.method).moneyBack.plus(payment.amount.negated());
        }
      }

      const ruleById = new Map(rules.map((r) => [r.id, r]));
      const taxSummary = [...taxByRule.entries()].map(([ruleId, collected]) => {
        const rule = ruleById.get(ruleId);
        const taxableBase =
          rule?.type === 'fixed' ? (fixedBaseByRule.get(ruleId) ?? ZERO) : rule && !rule.rate.isZero() ? collected.div(rule.rate).toDecimalPlaces(2) : ZERO;
        return {
          ruleId,
          ruleName: rule?.name ?? 'Unknown rule',
          type: rule?.type ?? 'percentage',
          rate: (rule?.rate ?? ZERO).toFixed(4),
          fixedAmount: rule?.fixedAmount?.toFixed(2) ?? null,
          inclusive: rule?.inclusive ?? false,
          taxableBase: taxableBase.toFixed(2),
          taxCollected: collected.toFixed(2),
        };
      });

      const rows = [...periods.entries()].map(([period, p]) => ({
        period,
        departments: Object.fromEntries([...p.departments.entries()].map(([k, v]) => [k, v.toFixed(2)])),
        revenue: p.revenue.toFixed(2),
        tax: p.tax.toFixed(2),
        moneyIn: p.moneyIn.toFixed(2),
        moneyBack: p.moneyBack.toFixed(2),
      }));
      const sum = (pick: (p: Period) => Prisma.Decimal) => [...periods.values()].reduce((s, p) => s.plus(pick(p)), ZERO);
      const revenue = sum((p) => p.revenue);
      const tax = sum((p) => p.tax);
      const moneyIn = sum((p) => p.moneyIn);
      const moneyBack = sum((p) => p.moneyBack);

      return {
        from: dto.from,
        to: dto.to,
        groupBy,
        currency: branch.currency,
        summary: {
          revenue: revenue.toFixed(2),
          tax: tax.toFixed(2),
          billed: revenue.plus(tax).toFixed(2),
          moneyIn: moneyIn.toFixed(2),
          moneyBack: moneyBack.toFixed(2),
          net: moneyIn.minus(moneyBack).toFixed(2),
        },
        departments: [...departments].sort(),
        periods: rows,
        taxSummary,
        posTax: posTax.toFixed(2),
        paymentMethods: [...methods.entries()].map(([name, m]) => ({ method: name, moneyIn: m.moneyIn.toFixed(2), moneyBack: m.moneyBack.toFixed(2) })),
      };
    });
  }

  // --- PDF export — one `renderReportPdf` layout shared by all four report
  // types (`report-pdf.util.ts`'s own header comment). Each method here is
  // just the adapter from that report's own JSON shape to the generic
  // {summary, tables} spec; the getX() call above it is the single source
  // of truth for the numbers themselves — never recomputed here.

  async getOccupancyPdf(tenantId: string, branchId: string, dto: ReportQueryDto): Promise<Buffer> {
    const r = await this.getOccupancy(tenantId, branchId, dto);
    return renderReportPdf({
      title: 'Occupancy Report',
      from: r.from,
      to: r.to,
      summary: [
        { label: 'Room Nights Available', value: String(r.summary.roomNightsAvailable) },
        { label: 'Room Nights Sold', value: String(r.summary.roomNightsSold) },
        { label: 'Occupancy', value: `${r.summary.occupancyPct}%` },
      ],
      tables: [
        {
          heading: 'By Room Type',
          columns: ['Room Type', 'Available', 'Sold', 'Occupancy %'],
          rows: r.byRoomType.map((row) => [row.roomTypeName, String(row.roomNightsAvailable), String(row.roomNightsSold), `${row.occupancyPct}%`]),
        },
        {
          heading: `Trend (${r.groupBy})`,
          columns: ['Period', 'Available', 'Sold', 'Occupancy %'],
          rows: r.trend.map((row) => [row.period, String(row.roomNightsAvailable), String(row.roomNightsSold), `${row.occupancyPct}%`]),
        },
      ],
    });
  }

  async getAdrPdf(tenantId: string, branchId: string, dto: ReportQueryDto): Promise<Buffer> {
    const r = await this.getAdr(tenantId, branchId, dto);
    return renderReportPdf({
      title: 'ADR Report (Average Daily Rate)',
      from: r.from,
      to: r.to,
      summary: [
        { label: 'Room Nights Sold', value: String(r.summary.roomNightsSold) },
        { label: 'Room Revenue', value: `${r.currency} ${r.summary.roomRevenue}` },
        { label: 'ADR', value: `${r.currency} ${r.summary.adr}` },
      ],
      tables: [
        {
          heading: 'By Room Type',
          columns: ['Room Type', 'Sold', 'Revenue', 'ADR'],
          rows: r.byRoomType.map((row) => [row.roomTypeName, String(row.roomNightsSold), row.roomRevenue, row.adr]),
        },
        {
          heading: 'Daily Trend',
          columns: ['Date', 'Sold', 'Revenue', 'ADR'],
          rows: r.trend.map((row) => [row.period, String(row.roomNightsSold), row.roomRevenue, row.adr]),
        },
      ],
    });
  }

  async getRevparPdf(tenantId: string, branchId: string, dto: ReportQueryDto): Promise<Buffer> {
    const r = await this.getRevpar(tenantId, branchId, dto);
    return renderReportPdf({
      title: 'RevPAR Report (Revenue Per Available Room)',
      from: r.from,
      to: r.to,
      summary: [
        { label: 'Room Nights Available', value: String(r.summary.roomNightsAvailable) },
        { label: 'Room Revenue', value: `${r.currency} ${r.summary.roomRevenue}` },
        { label: 'RevPAR', value: `${r.currency} ${r.summary.revpar}` },
      ],
      tables: [
        {
          heading: 'By Room Type',
          columns: ['Room Type', 'Available', 'Revenue', 'RevPAR'],
          rows: r.byRoomType.map((row) => [row.roomTypeName, String(row.roomNightsAvailable), row.roomRevenue, row.revpar]),
        },
        {
          heading: 'Daily Trend',
          columns: ['Date', 'Available', 'Revenue', 'RevPAR'],
          rows: r.trend.map((row) => [row.period, String(row.roomNightsAvailable), row.roomRevenue, row.revpar]),
        },
      ],
    });
  }

  async getRevenuePdf(tenantId: string, branchId: string, dto: ReportQueryDto): Promise<Buffer> {
    const r = await this.getRevenue(tenantId, branchId, dto);
    return renderReportPdf({
      title: 'Revenue Report',
      from: r.from,
      to: r.to,
      summary: [{ label: 'Total Revenue', value: `${r.currency} ${r.summary.totalRevenue}` }],
      tables: [
        {
          heading: 'By Department',
          columns: ['Department', 'Amount'],
          rows: r.byDepartment.map((row) => [row.chargeType, `${r.currency} ${row.amount}`]),
        },
        {
          heading: 'By Payment Method',
          columns: ['Method', 'Amount'],
          rows: r.byPaymentMethod.map((row) => [row.method, `${r.currency} ${row.amount}`]),
        },
        {
          heading: 'Daily Trend',
          columns: ['Date', 'Amount'],
          rows: r.trend.map((row) => [row.period, `${r.currency} ${row.amount}`]),
        },
      ],
    });
  }
}
