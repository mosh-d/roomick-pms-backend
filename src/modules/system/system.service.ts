import { Injectable } from '@nestjs/common';
import { MetricsService, RequestMetricsSnapshot } from '../../common/metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';

export interface HealthReport {
  status: 'ok' | 'degraded';
  timestamp: string;
  checks: {
    database: 'up' | 'down';
  };
}

export interface DetailedHealthReport extends HealthReport {
  checks: {
    database: 'up' | 'down';
    databaseLatencyMs: number;
  };
  process: {
    uptimeSeconds: number;
    memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  };
  requestMetrics: RequestMetricsSnapshot;
}

@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  async health(): Promise<HealthReport> {
    let database: 'up' | 'down' = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: { database },
    };
  }

  /**
   * System Admin's "System Health Monitor" (ref: "CPU, DB, API response
   * times, error rates"). CPU specifically is NOT included — `process
   * .cpuUsage()` only means something as a delta over a measured interval,
   * and Windows has no `os.loadavg()` equivalent — memory + DB latency +
   * request metrics are the honest subset actually measurable here without
   * new sampling infrastructure this pass doesn't build.
   */
  async detailedHealth(): Promise<DetailedHealthReport> {
    const dbStart = Date.now();
    let database: 'up' | 'down' = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }
    const databaseLatencyMs = Date.now() - dbStart;
    const mem = process.memoryUsage();

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: { database, databaseLatencyMs },
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        memory: {
          rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
          heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
          heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
        },
      },
      requestMetrics: this.metrics.snapshot(),
    };
  }
}
