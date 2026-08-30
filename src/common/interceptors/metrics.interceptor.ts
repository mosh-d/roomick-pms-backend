import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Every request, including `@Public()` ones (login/register/health) — the
 * System Health Monitor's own "API response times, error rates" should
 * reflect real traffic, not just authenticated business routes. Registered
 * FIRST among the `APP_INTERCEPTOR`s in `app.module.ts` so its own
 * `next.handle()` wraps every interceptor after it, timing the full
 * remaining pipeline rather than just its own no-op work.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = Date.now();
    return next.handle().pipe(
      tap({
        next: () => this.metrics.record(Date.now() - start, false),
        error: () => this.metrics.record(Date.now() - start, true),
      }),
    );
  }
}
