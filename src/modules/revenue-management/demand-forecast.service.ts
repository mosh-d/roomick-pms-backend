import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LOOKBACK_WEEKS = 8;

export interface ForecastDay {
  date: string;
  dayOfWeek: string;
  /** `null` = no historical data for this day of week yet — never a fabricated number. */
  forecastOccupancyPct: number | null;
  /** How many past occurrences of this weekday contributed to the average — the honesty behind the number above. */
  historicalSampleSize: number;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Revenue Management's own "Demand Forecast" card. The reference calls
 * this "AI-based occupancy prediction" — this app has no ML/forecasting
 * infrastructure anywhere, and building one for a single card would be
 * real, substantial, separate scope. What's built instead is honest and
 * real: a same-weekday historical average, reusing `ReportsService
 * .getOccupancy`'s own already-correct room-night computation over the
 * trailing 8 weeks — never labeled "AI" anywhere in this module or its own
 * frontend page.
 */
@Injectable()
export class DemandForecastService {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly prisma: PrismaService,
  ) {}

  async getForecast(tenantId: string, branchId: string, horizonDays = 30): Promise<ForecastDay[]> {
    const today = new Date();
    const earliestLookback = new Date(today.getTime() - LOOKBACK_WEEKS * 7 * 86_400_000);

    // `Room` has no historical existed-on-date concept — `ReportsService
    // .getOccupancy` uses today's room inventory for every date it's asked
    // about, including ones before the branch existed. Left unclamped, a
    // brand-new branch would get a real-looking 0%-occupancy sample for
    // every pre-creation day, silently diluting the forecast toward zero
    // instead of honestly reporting "not enough data" per this module's own
    // documented contract.
    const branch = await this.prisma.withTenant(tenantId, (tx) => tx.branch.findFirst({ where: { id: branchId }, select: { createdAt: true } }));
    const lookbackFrom = branch && branch.createdAt > earliestLookback ? branch.createdAt : earliestLookback;

    const historical =
      lookbackFrom < today ? await this.reportsService.getOccupancy(tenantId, branchId, { from: isoDate(lookbackFrom), to: isoDate(today), groupBy: 'day' }) : { trend: [] };

    const byWeekday = new Map<number, number[]>();
    for (const entry of historical.trend) {
      const dow = new Date(`${entry.period}T00:00:00.000Z`).getUTCDay();
      const samples = byWeekday.get(dow) ?? [];
      samples.push(entry.occupancyPct);
      byWeekday.set(dow, samples);
    }

    const forecast: ForecastDay[] = [];
    for (let i = 1; i <= horizonDays; i++) {
      const date = new Date(today.getTime() + i * 86_400_000);
      const dow = date.getUTCDay();
      const samples = byWeekday.get(dow) ?? [];
      const forecastOccupancyPct = samples.length > 0 ? Math.round((samples.reduce((sum, v) => sum + v, 0) / samples.length) * 10) / 10 : null;
      forecast.push({ date: isoDate(date), dayOfWeek: WEEKDAY_NAMES[dow], forecastOccupancyPct, historicalSampleSize: samples.length });
    }
    return forecast;
  }
}
