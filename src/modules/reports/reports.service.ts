import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { ReportGroupBy, ReportQueryDto } from './dto/report-query.dto';

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
  private async roomNightMetrics(tx: TenantTx, branchId: string, from: Date, to: Date, roomTypeId?: string) {
    const roomTypes = await tx.roomType.findMany({
      where: { branchId, deletedAt: null, ...(roomTypeId ? { id: roomTypeId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    const poolByType = new Map<string, number>();
    for (const rt of roomTypes) {
      poolByType.set(rt.id, await tx.room.count({ where: { branchId, roomTypeId: rt.id, deletedAt: null } }));
    }

    const reservations = await tx.reservation.findMany({
      where: {
        branchId,
        deletedAt: null,
        status: { in: [...SOLD_STATUSES] },
        checkInDate: { lt: to },
        checkOutDate: { gt: from },
        ...(roomTypeId ? { roomTypeId } : {}),
      },
      select: { roomTypeId: true, checkInDate: true, checkOutDate: true },
    });

    const roomRevenueRows = await tx.lineItem.findMany({
      where: {
        folio: { branchId, ...(roomTypeId ? { reservation: { roomTypeId } } : {}) },
        chargeType: 'room',
        isVoid: false,
        deletedAt: null,
        serviceDate: { gte: from, lt: to },
      },
      select: { amount: true, serviceDate: true, folio: { select: { reservation: { select: { roomTypeId: true } } } } },
    });

    const days = this.enumerateDays(from, to);
    const buckets = new Map<string, RoomNightBucket>(); // key: `${isoDate}|${roomTypeId}`

    for (const day of days) {
      const dateStr = this.isoDate(day);
      for (const rt of roomTypes) {
        buckets.set(`${dateStr}|${rt.id}`, { available: poolByType.get(rt.id) ?? 0, sold: 0, revenue: ZERO });
      }
    }
    for (const r of reservations) {
      for (const day of days) {
        if (day >= r.checkInDate && day < r.checkOutDate) {
          const bucket = buckets.get(`${this.isoDate(day)}|${r.roomTypeId}`);
          if (bucket) bucket.sold += 1;
        }
      }
    }
    for (const row of roomRevenueRows) {
      const rtId = row.folio.reservation?.roomTypeId;
      if (!rtId || !row.serviceDate) continue;
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
    const from = toBranchDate(dto.from);
    const to = toBranchDate(dto.to);
    const groupBy = dto.groupBy ?? 'day';
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const { roomTypes, days, buckets } = await this.roomNightMetrics(tx, branchId, from, to, dto.roomTypeId);
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
    const from = toBranchDate(dto.from);
    const to = toBranchDate(dto.to);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const { roomTypes, days, buckets } = await this.roomNightMetrics(tx, branchId, from, to, dto.roomTypeId);
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
    const from = toBranchDate(dto.from);
    const to = toBranchDate(dto.to);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const { roomTypes, days, buckets } = await this.roomNightMetrics(tx, branchId, from, to, dto.roomTypeId);
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
   * Revenue by department (`LineItem.chargeType`, excluding `tax`/
   * `correction` — display denormalisation and reversals, not real
   * department revenue) and by payment method, plus a day-level trend.
   * `groupBy=department` in the reference's own querystring is really just
   * naming which breakdown the UI leads with — this always returns both.
   */
  async getRevenue(tenantId: string, branchId: string, dto: ReportQueryDto) {
    const from = toBranchDate(dto.from);
    const to = toBranchDate(dto.to);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);

      const lineItems = await tx.lineItem.findMany({
        where: {
          folio: { branchId },
          isVoid: false,
          deletedAt: null,
          chargeType: { notIn: ['tax', 'correction'] },
          serviceDate: { gte: from, lt: to },
        },
        select: { amount: true, chargeType: true, serviceDate: true },
      });
      const payments = await tx.payment.findMany({
        where: { folio: { branchId }, isVoid: false, deletedAt: null, recordedAt: { gte: from, lt: to } },
        select: { amount: true, method: true },
      });

      const byDepartment = new Map<string, Prisma.Decimal>();
      for (const li of lineItems) {
        byDepartment.set(li.chargeType, (byDepartment.get(li.chargeType) ?? ZERO).plus(li.amount));
      }
      const byPaymentMethod = new Map<string, Prisma.Decimal>();
      for (const p of payments) {
        byPaymentMethod.set(p.method, (byPaymentMethod.get(p.method) ?? ZERO).plus(p.amount));
      }
      const totalRevenue = [...byDepartment.values()].reduce((s, v) => s.plus(v), ZERO);

      const trendMap = new Map<string, Prisma.Decimal>();
      for (const li of lineItems) {
        if (!li.serviceDate) continue;
        const key = this.isoDate(li.serviceDate);
        trendMap.set(key, (trendMap.get(key) ?? ZERO).plus(li.amount));
      }
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
}
