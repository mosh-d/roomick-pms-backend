import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { DemandForecastService } from './demand-forecast.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const LONG_AGO = new Date('2020-01-01T00:00:00.000Z');

describe('DemandForecastService', () => {
  let service: DemandForecastService;
  let reportsService: { getOccupancy: jest.Mock };
  let prisma: { withTenant: jest.Mock };
  let branchCreatedAt: Date;

  beforeEach(async () => {
    branchCreatedAt = LONG_AGO;
    reportsService = { getOccupancy: jest.fn() };
    prisma = { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn({ branch: { findFirst: jest.fn().mockImplementation(() => Promise.resolve({ createdAt: branchCreatedAt })) } })) };
    const moduleRef = await Test.createTestingModule({
      providers: [DemandForecastService, { provide: ReportsService, useValue: reportsService }, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(DemandForecastService);
  });

  it('returns a null forecast with a zero sample size for every day when there is no historical data', async () => {
    reportsService.getOccupancy.mockResolvedValue({ trend: [] });
    const forecast = await service.getForecast(TENANT_ID, BRANCH_ID, 7);
    expect(forecast).toHaveLength(7);
    for (const day of forecast) {
      expect(day.forecastOccupancyPct).toBeNull();
      expect(day.historicalSampleSize).toBe(0);
    }
  });

  it('averages same-weekday historical occupancy into the forecast for that weekday', async () => {
    // Two Sundays (2026-08-02, 2026-08-09) sit 4 weeks back from "today" —
    // well inside the service's own 8-week lookback window regardless of
    // when this test actually runs.
    const today = new Date();
    const fourWeeksAgo = new Date(today.getTime() - 28 * 86_400_000);
    const dow = fourWeeksAgo.getUTCDay();
    const oneWeekBefore = new Date(fourWeeksAgo.getTime() - 7 * 86_400_000);
    reportsService.getOccupancy.mockResolvedValue({
      trend: [
        { period: fourWeeksAgo.toISOString().slice(0, 10), occupancyPct: 80 },
        { period: oneWeekBefore.toISOString().slice(0, 10), occupancyPct: 60 },
      ],
    });

    const forecast = await service.getForecast(TENANT_ID, BRANCH_ID, 30);
    const matchingDay = forecast.find((d) => new Date(`${d.date}T00:00:00.000Z`).getUTCDay() === dow);

    expect(matchingDay).toBeDefined();
    expect(matchingDay!.historicalSampleSize).toBe(2);
    expect(matchingDay!.forecastOccupancyPct).toBe(70); // (80 + 60) / 2
  });

  it('passes an 8-week lookback window and day grouping through to ReportsService.getOccupancy for a long-established branch', async () => {
    reportsService.getOccupancy.mockResolvedValue({ trend: [] });
    await service.getForecast(TENANT_ID, BRANCH_ID, 30);
    expect(reportsService.getOccupancy).toHaveBeenCalledWith(TENANT_ID, BRANCH_ID, expect.objectContaining({ groupBy: 'day' }));
  });

  it('respects the horizonDays parameter', async () => {
    reportsService.getOccupancy.mockResolvedValue({ trend: [] });
    const forecast = await service.getForecast(TENANT_ID, BRANCH_ID, 3);
    expect(forecast).toHaveLength(3);
  });

  it('clamps the lookback window to the branch\'s own createdAt instead of querying pre-existence days as real 0% occupancy history', async () => {
    branchCreatedAt = new Date(Date.now() - 3 * 86_400_000); // branch is 3 days old
    reportsService.getOccupancy.mockResolvedValue({ trend: [] });
    await service.getForecast(TENANT_ID, BRANCH_ID, 7);
    const callArgs = reportsService.getOccupancy.mock.calls[0][2];
    expect(callArgs.from).toBe(branchCreatedAt.toISOString().slice(0, 10));
  });

  it('collapses the queried range to a single day for a branch created today, rather than treating any prior day as real history', async () => {
    // A few seconds in the past, not `new Date()` itself — otherwise this
    // and the service's own `today` can land on the identical millisecond,
    // making `lookbackFrom < today` false and skipping the call entirely.
    branchCreatedAt = new Date(Date.now() - 5_000);
    reportsService.getOccupancy.mockResolvedValue({ trend: [{ period: branchCreatedAt.toISOString().slice(0, 10), occupancyPct: 0 }] });
    await service.getForecast(TENANT_ID, BRANCH_ID, 7);
    const callArgs = reportsService.getOccupancy.mock.calls[0][2];
    expect(callArgs.from).toBe(callArgs.to);
  });
});
