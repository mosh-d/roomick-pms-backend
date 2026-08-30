import { Test } from '@nestjs/testing';
import { MetricsService } from '../../common/metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemService } from './system.service';

describe('SystemService', () => {
  let service: SystemService;
  let prisma: { $queryRaw: jest.Mock };
  let metrics: { snapshot: jest.Mock };

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    metrics = { snapshot: jest.fn().mockReturnValue({ windowMinutes: 15, requestCount: 3, errorCount: 0, avgResponseTimeMs: 42, errorRatePct: 0 }) };
    const moduleRef = await Test.createTestingModule({
      providers: [SystemService, { provide: PrismaService, useValue: prisma }, { provide: MetricsService, useValue: metrics }],
    }).compile();
    service = moduleRef.get(SystemService);
  });

  describe('health', () => {
    it('reports ok/up when the DB query succeeds', async () => {
      const result = await service.health();
      expect(result).toEqual({ status: 'ok', timestamp: expect.any(String), checks: { database: 'up' } });
    });

    it('reports degraded/down when the DB query throws', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
      const result = await service.health();
      expect(result.status).toBe('degraded');
      expect(result.checks.database).toBe('down');
    });
  });

  describe('detailedHealth', () => {
    it('includes DB latency, process memory/uptime, and the request-metrics snapshot', async () => {
      const result = await service.detailedHealth();
      expect(result.checks.database).toBe('up');
      expect(result.checks.databaseLatencyMs).toBeGreaterThanOrEqual(0);
      expect(result.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(result.process.memory.heapUsedMb).toBeGreaterThan(0);
      expect(result.requestMetrics).toEqual({ windowMinutes: 15, requestCount: 3, errorCount: 0, avgResponseTimeMs: 42, errorRatePct: 0 });
      expect(metrics.snapshot).toHaveBeenCalled();
    });

    it('reports degraded status when the DB is down, alongside the still-measured process metrics', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('down'));
      const result = await service.detailedHealth();
      expect(result.status).toBe('degraded');
      expect(result.checks.database).toBe('down');
      expect(result.process).toBeDefined();
    });
  });
});
