import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RateResolverService } from '../rate-resolver/rate-resolver.service';
import { DemandForecastService } from './demand-forecast.service';
import { RateRecommendationsService } from './rate-recommendations.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const ROOM_TYPE_ID = '33333333-3333-4333-8333-333333333333';

describe('RateRecommendationsService', () => {
  let service: RateRecommendationsService;
  let prisma: { withTenant: jest.Mock };
  let demandForecastService: { getForecast: jest.Mock };
  let rateResolverService: { createRatePlan: jest.Mock };

  beforeEach(async () => {
    prisma = { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn({ roomType: { findFirst: jest.fn().mockResolvedValue({ id: ROOM_TYPE_ID, baseRate: 100 }) } })) };
    demandForecastService = { getForecast: jest.fn() };
    rateResolverService = { createRatePlan: jest.fn().mockResolvedValue({ id: 'plan-1' }) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        RateRecommendationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: DemandForecastService, useValue: demandForecastService },
        { provide: RateResolverService, useValue: rateResolverService },
      ],
    }).compile();
    service = moduleRef.get(RateRecommendationsService);
  });

  describe('getRecommendations', () => {
    it('throws NOT_FOUND when the room type does not belong to this branch', async () => {
      prisma.withTenant.mockImplementationOnce((_t: string, fn: (x: unknown) => unknown) => fn({ roomType: { findFirst: jest.fn().mockResolvedValue(null) } }));
      await expect(service.getRecommendations(TENANT_ID, BRANCH_ID, ROOM_TYPE_ID)).rejects.toMatchObject({ status: 404 });
    });

    it('suggests no adjustment and explains the lack of data when the forecast has no sample', async () => {
      demandForecastService.getForecast.mockResolvedValue([{ date: '2026-09-15', dayOfWeek: 'Tuesday', forecastOccupancyPct: null, historicalSampleSize: 0 }]);
      const [rec] = await service.getRecommendations(TENANT_ID, BRANCH_ID, ROOM_TYPE_ID);
      expect(rec.suggestedAdjustmentPct).toBe(0);
      expect(rec.suggestedRate).toBe('100.00');
      expect(rec.rationale).toMatch(/not enough historical data/i);
    });

    it('suggests raising the rate when forecast occupancy is high', async () => {
      demandForecastService.getForecast.mockResolvedValue([{ date: '2026-09-15', dayOfWeek: 'Friday', forecastOccupancyPct: 90, historicalSampleSize: 6 }]);
      const [rec] = await service.getRecommendations(TENANT_ID, BRANCH_ID, ROOM_TYPE_ID);
      expect(rec.suggestedAdjustmentPct).toBe(15);
      expect(rec.suggestedRate).toBe('115.00');
      expect(rec.rationale).toMatch(/raising the rate/i);
    });

    it('suggests a discount when forecast occupancy is low', async () => {
      demandForecastService.getForecast.mockResolvedValue([{ date: '2026-09-15', dayOfWeek: 'Tuesday', forecastOccupancyPct: 10, historicalSampleSize: 6 }]);
      const [rec] = await service.getRecommendations(TENANT_ID, BRANCH_ID, ROOM_TYPE_ID);
      expect(rec.suggestedAdjustmentPct).toBe(-10);
      expect(rec.suggestedRate).toBe('90.00');
      expect(rec.rationale).toMatch(/discount/i);
    });

    it('suggests no adjustment for occupancy in the typical range', async () => {
      demandForecastService.getForecast.mockResolvedValue([{ date: '2026-09-15', dayOfWeek: 'Tuesday', forecastOccupancyPct: 50, historicalSampleSize: 6 }]);
      const [rec] = await service.getRecommendations(TENANT_ID, BRANCH_ID, ROOM_TYPE_ID);
      expect(rec.suggestedAdjustmentPct).toBe(0);
      expect(rec.suggestedRate).toBe('100.00');
    });
  });

  describe('approveRecommendation', () => {
    it('rejects an approval with a zero adjustment', async () => {
      await expect(service.approveRecommendation(TENANT_ID, BRANCH_ID, { roomTypeId: ROOM_TYPE_ID, date: '2026-09-15', adjustmentPct: 0 })).rejects.toMatchObject({ status: 400 });
      expect(rateResolverService.createRatePlan).not.toHaveBeenCalled();
    });

    it('creates a single-day seasonal percentage rate plan with the signed adjustment', async () => {
      await service.approveRecommendation(TENANT_ID, BRANCH_ID, { roomTypeId: ROOM_TYPE_ID, date: '2026-09-15', adjustmentPct: 15 });
      expect(rateResolverService.createRatePlan).toHaveBeenCalledWith(TENANT_ID, BRANCH_ID, {
        roomTypeId: ROOM_TYPE_ID,
        name: 'Rate Recommendation — 2026-09-15',
        type: 'seasonal',
        amount: 15,
        adjustmentType: 'percentage',
        validFrom: '2026-09-15',
        validTo: '2026-09-16',
      });
    });

    it('passes a negative adjustment straight through as a real discount, with no Math.abs applied', async () => {
      await service.approveRecommendation(TENANT_ID, BRANCH_ID, { roomTypeId: ROOM_TYPE_ID, date: '2026-09-15', adjustmentPct: -10 });
      expect(rateResolverService.createRatePlan).toHaveBeenCalledWith(TENANT_ID, BRANCH_ID, expect.objectContaining({ amount: -10 }));
    });
  });
});
