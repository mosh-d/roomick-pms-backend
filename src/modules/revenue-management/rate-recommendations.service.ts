import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { RatePlan } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { RateResolverService } from '../rate-resolver/rate-resolver.service';
import { DemandForecastService } from './demand-forecast.service';
import { ApproveRateRecommendationDto } from './dto/revenue-management.dto';

const HIGH_OCCUPANCY_THRESHOLD = 75;
const LOW_OCCUPANCY_THRESHOLD = 25;
const RAISE_PCT = 15;
const DISCOUNT_PCT = -10;

export interface RateRecommendation {
  date: string;
  dayOfWeek: string;
  forecastOccupancyPct: number | null;
  currentBaseRate: string;
  suggestedAdjustmentPct: number;
  suggestedRate: string;
  rationale: string;
}

/**
 * Revenue Management's own "Rate Recommendations" card. The reference
 * calls these "AI-suggested" — this app has no ML infrastructure, so these
 * are plain, fixed-threshold, rule-based suggestions off the same honest
 * `DemandForecastService` this module already built, never labeled "AI"
 * anywhere. Approving one doesn't invent a parallel rate mechanism either:
 * it creates a real, ordinary `seasonal` `RatePlan` (a single-day date
 * range, percentage adjustment) through the SAME `RateResolverService
 * .createRatePlan` the Rate Plan Management page already uses — so an
 * approved recommendation takes effect through the normal rate cascade,
 * exactly like a manually-created seasonal rate would.
 */
@Injectable()
export class RateRecommendationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly demandForecastService: DemandForecastService,
    private readonly rateResolverService: RateResolverService,
  ) {}

  async getRecommendations(tenantId: string, branchId: string, roomTypeId: string, horizonDays = 14): Promise<RateRecommendation[]> {
    const roomType = await this.prisma.withTenant(tenantId, (tx) => tx.roomType.findFirst({ where: { id: roomTypeId, branchId } }));
    if (!roomType) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found at this branch' });

    const forecast = await this.demandForecastService.getForecast(tenantId, branchId, horizonDays);
    const baseRate = Number(roomType.baseRate);

    return forecast.map((day) => {
      let adjustmentPct = 0;
      let rationale = 'Forecasted occupancy is in the typical range — no adjustment suggested.';
      if (day.forecastOccupancyPct === null) {
        rationale = `Not enough historical data for ${day.dayOfWeek}s yet — no suggestion.`;
      } else if (day.forecastOccupancyPct >= HIGH_OCCUPANCY_THRESHOLD) {
        adjustmentPct = RAISE_PCT;
        rationale = `Historical ${day.dayOfWeek} occupancy averages ${day.forecastOccupancyPct}% (${day.historicalSampleSize}-week sample) — consider raising the rate.`;
      } else if (day.forecastOccupancyPct <= LOW_OCCUPANCY_THRESHOLD) {
        adjustmentPct = DISCOUNT_PCT;
        rationale = `Historical ${day.dayOfWeek} occupancy averages ${day.forecastOccupancyPct}% (${day.historicalSampleSize}-week sample) — consider a discount to drive demand.`;
      }
      const suggestedRate = baseRate * (1 + adjustmentPct / 100);
      return {
        date: day.date,
        dayOfWeek: day.dayOfWeek,
        forecastOccupancyPct: day.forecastOccupancyPct,
        currentBaseRate: baseRate.toFixed(2),
        suggestedAdjustmentPct: adjustmentPct,
        suggestedRate: suggestedRate.toFixed(2),
        rationale,
      };
    });
  }

  async approveRecommendation(tenantId: string, branchId: string, dto: ApproveRateRecommendationDto): Promise<RatePlan> {
    if (dto.adjustmentPct === 0) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'There is no adjustment to approve for this date' });
    }
    const nextDay = new Date(new Date(`${dto.date}T00:00:00.000Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
    return this.rateResolverService.createRatePlan(tenantId, branchId, {
      roomTypeId: dto.roomTypeId,
      name: `Rate Recommendation — ${dto.date}`,
      type: 'seasonal',
      amount: dto.adjustmentPct,
      adjustmentType: 'percentage',
      validFrom: dto.date,
      validTo: nextDay,
    });
  }
}
