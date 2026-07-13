import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface HealthReport {
  status: 'ok' | 'degraded';
  timestamp: string;
  checks: {
    database: 'up' | 'down';
  };
}

@Injectable()
export class SystemService {
  constructor(private readonly prisma: PrismaService) {}

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
}
