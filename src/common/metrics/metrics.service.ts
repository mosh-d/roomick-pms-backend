import { Injectable } from '@nestjs/common';

interface MetricSample {
  at: number;
  durationMs: number;
  isError: boolean;
}

export interface RequestMetricsSnapshot {
  windowMinutes: number;
  requestCount: number;
  errorCount: number;
  avgResponseTimeMs: number | null;
  errorRatePct: number | null;
}

const WINDOW_MS = 15 * 60_000;

/**
 * System Admin's "System Health Monitor" card (ref) names "API response
 * times, error rates" as data this app has never collected anywhere —
 * confirmed directly: no `@nestjs/terminus`, no Prometheus client, no
 * request-timing middleware existed before this. A rolling in-memory
 * window (last 15 minutes, pruned on every read/write) is the honest,
 * minimal answer — same "don't build infra the data volume doesn't need
 * yet" call Reports' own `TrendBars`/skip-materialized-views made. It
 * resets on every process restart and isn't persisted; that's a real,
 * stated limitation, not hidden from the UI that reads it.
 */
@Injectable()
export class MetricsService {
  private samples: MetricSample[] = [];

  record(durationMs: number, isError: boolean): void {
    const now = Date.now();
    this.samples.push({ at: now, durationMs, isError });
    this.prune(now);
  }

  snapshot(): RequestMetricsSnapshot {
    this.prune(Date.now());
    const requestCount = this.samples.length;
    const errorCount = this.samples.filter((s) => s.isError).length;
    return {
      windowMinutes: WINDOW_MS / 60_000,
      requestCount,
      errorCount,
      avgResponseTimeMs: requestCount > 0 ? Math.round(this.samples.reduce((sum, s) => sum + s.durationMs, 0) / requestCount) : null,
      errorRatePct: requestCount > 0 ? Math.round((errorCount / requestCount) * 1000) / 10 : null,
    };
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (this.samples.length > 0 && this.samples[0].at < cutoff) this.samples.shift();
  }
}
