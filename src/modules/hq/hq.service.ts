import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ReportQueryDto } from '../reports/dto/report-query.dto';
import { ReportsService } from '../reports/reports.service';
import { FoliosService } from '../folios/folios.service';
import { CrossPropertyReportType } from './dto/hq.dto';

const ZERO = new Prisma.Decimal(0);

export interface PortfolioBranchSummary {
  branchId: string;
  branchName: string;
  brandId: string;
  brandName: string;
  currency: string;
  totalRooms: number;
  occupiedRooms: number;
  occupancyPctNow: number;
  inHouseReservations: number;
  outstandingBalance: string;
}

export interface PortfolioOverview {
  brandCount: number;
  branchCount: number;
  branches: PortfolioBranchSummary[];
}

export interface CrossPropertyReportRow {
  branchId: string;
  branchName: string;
  currency: string;
  summary: Record<string, unknown>;
}

export interface CrossPropertyReport {
  type: CrossPropertyReportType;
  from: string;
  to: string;
  mixedCurrencies: boolean;
  rows: CrossPropertyReportRow[];
  /** `null` when `rows` span more than one currency — summing revenue-denominated figures across currencies with no FX conversion in this app would be a fabricated number, not a real one. Occupancy is always blendable (room-nights carry no currency). */
  blendedTotal: Record<string, unknown> | null;
}

/**
 * Enterprise / HQ (ref p25) — one of the architecture map's own named gaps
 * (`page-hq`). Unlike Revenue Management/Sales & Events, this is almost
 * entirely composition of pieces that already existed: brand/branch CRUD
 * (`PropertyController`'s own `/brands`, `/brands/:brandId/branches`) needs
 * no new backend at all — the frontend calls those routes directly. Only
 * Portfolio Overview and Cross-Property Reports are genuinely new, and both
 * are built by looping the SAME per-branch primitives (room/reservation
 * counts, `FoliosService.listFolios`, `ReportsService`'s own four report
 * methods) other pages already established, not new computation.
 */
@Injectable()
export class HqService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foliosService: FoliosService,
    private readonly reportsService: ReportsService,
  ) {}

  /**
   * "All brands and branches at a glance" — a live snapshot (occupied/total
   * rooms right now), not a date-ranged report; Cross-Property Reports below
   * is where actual report windows belong. `outstandingBalance` reuses
   * `FoliosService.listFolios`'s own real balance computation (tax, payments,
   * corrections all already accounted for there) rather than re-deriving a
   * simplified — and likely wrong — balance calculation here.
   */
  async getPortfolio(tenantId: string): Promise<PortfolioOverview> {
    const { brands, branches } = await this.prisma.withTenant(tenantId, async (tx) => {
      const brands = await tx.brand.findMany({ where: { deletedAt: null } });
      const branches = await tx.branch.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
      return { brands, branches };
    });
    const brandNameById = new Map(brands.map((b) => [b.id, b.name]));

    const rows = await Promise.all(
      branches.map(async (branch): Promise<PortfolioBranchSummary> => {
        const [totalRooms, occupiedRooms, inHouseReservations] = await this.prisma.withTenant(tenantId, (tx) =>
          Promise.all([
            tx.room.count({ where: { branchId: branch.id, deletedAt: null } }),
            tx.room.count({ where: { branchId: branch.id, deletedAt: null, occupancyStatus: 'occupied' } }),
            tx.reservation.count({ where: { branchId: branch.id, status: 'checked_in' } }),
          ]),
        );
        const outstandingFolios = await this.foliosService.listFolios(tenantId, branch.id, 'outstanding');
        const outstandingBalance = outstandingFolios.reduce((sum, f) => sum.plus(f.balanceDue), ZERO);

        return {
          branchId: branch.id,
          branchName: branch.name,
          brandId: branch.brandId,
          brandName: brandNameById.get(branch.brandId) ?? 'Unknown',
          currency: branch.currency,
          totalRooms,
          occupiedRooms,
          occupancyPctNow: totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 1000) / 10 : 0,
          inHouseReservations,
          outstandingBalance: outstandingBalance.toFixed(2),
        };
      }),
    );

    return { brandCount: brands.length, branchCount: branches.length, branches: rows };
  }

  /**
   * Loops the SAME `ReportsService` methods every single-branch report page
   * already calls — never a parallel/duplicate computation. The blended
   * total is a real recomputation from each branch's own underlying
   * components (room-nights, revenue), not an average of already-rounded
   * percentages, which would silently misweight a 5-room branch the same as
   * a 200-room one.
   */
  async getCrossPropertyReport(tenantId: string, type: CrossPropertyReportType, dto: ReportQueryDto, branchIds?: string[]): Promise<CrossPropertyReport> {
    const branches = await this.prisma.withTenant(tenantId, (tx) =>
      tx.branch.findMany({
        where: { deletedAt: null, ...(branchIds && branchIds.length > 0 ? { id: { in: branchIds } } : {}) },
        orderBy: { name: 'asc' },
      }),
    );

    const rows: CrossPropertyReportRow[] = await Promise.all(
      branches.map(async (branch) => {
        const report =
          type === 'occupancy'
            ? await this.reportsService.getOccupancy(tenantId, branch.id, dto)
            : type === 'adr'
              ? await this.reportsService.getAdr(tenantId, branch.id, dto)
              : type === 'revpar'
                ? await this.reportsService.getRevpar(tenantId, branch.id, dto)
                : await this.reportsService.getRevenue(tenantId, branch.id, dto);
        return { branchId: branch.id, branchName: branch.name, currency: branch.currency, summary: report.summary };
      }),
    );

    const mixedCurrencies = new Set(branches.map((b) => b.currency)).size > 1;
    const blendedTotal = this.computeBlendedTotal(type, rows, mixedCurrencies);

    return { type, from: dto.from, to: dto.to, mixedCurrencies, rows, blendedTotal };
  }

  private computeBlendedTotal(type: CrossPropertyReportType, rows: CrossPropertyReportRow[], mixedCurrencies: boolean): Record<string, unknown> | null {
    if (rows.length === 0) return null;

    if (type === 'occupancy') {
      const totalAvailable = rows.reduce((s, r) => s + Number((r.summary as { roomNightsAvailable: number }).roomNightsAvailable), 0);
      const totalSold = rows.reduce((s, r) => s + Number((r.summary as { roomNightsSold: number }).roomNightsSold), 0);
      return { roomNightsAvailable: totalAvailable, roomNightsSold: totalSold, occupancyPct: totalAvailable > 0 ? Math.round((totalSold / totalAvailable) * 1000) / 10 : 0 };
    }

    // Every other report type carries a currency-denominated figure — never sum those across a mixed-currency set with no FX conversion.
    if (mixedCurrencies) return null;

    if (type === 'adr') {
      const totalSold = rows.reduce((s, r) => s + Number((r.summary as { roomNightsSold: number }).roomNightsSold), 0);
      const totalRevenue = rows.reduce((s, r) => s.plus(new Prisma.Decimal((r.summary as { roomRevenue: string }).roomRevenue)), ZERO);
      return { roomNightsSold: totalSold, roomRevenue: totalRevenue.toFixed(2), adr: totalSold > 0 ? totalRevenue.div(totalSold).toFixed(2) : '0.00' };
    }
    if (type === 'revpar') {
      const totalAvailable = rows.reduce((s, r) => s + Number((r.summary as { roomNightsAvailable: number }).roomNightsAvailable), 0);
      const totalRevenue = rows.reduce((s, r) => s.plus(new Prisma.Decimal((r.summary as { roomRevenue: string }).roomRevenue)), ZERO);
      return { roomNightsAvailable: totalAvailable, roomRevenue: totalRevenue.toFixed(2), revpar: totalAvailable > 0 ? totalRevenue.div(totalAvailable).toFixed(2) : '0.00' };
    }
    // revenue
    const totalRevenue = rows.reduce((s, r) => s.plus(new Prisma.Decimal((r.summary as { totalRevenue: string }).totalRevenue)), ZERO);
    return { totalRevenue: totalRevenue.toFixed(2) };
  }
}
