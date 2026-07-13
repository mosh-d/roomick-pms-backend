import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import { Prisma } from '@prisma/client';
import { TenantContextService } from '../context/tenant-context.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedRequest } from '../types/request-context';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Spec §6: every mutating request writes an audit_log row (userId, tenantId,
 * action, entity, entityId, before/after diff, IP). GETs are skipped except
 * `?reveal=true` reads of masked PII.
 *
 * P0 scaffold: `action` is derived from the route and `after` captures the
 * response body. Services that know their true before/after states (P1+)
 * should write richer rows through AuditService (to come) — this interceptor
 * is the safety net that guarantees nothing mutating goes unlogged.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly context: TenantContextService,
  ) {}

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = executionContext.switchToHttp().getRequest<AuthenticatedRequest>();
    const isReveal = request.query?.reveal === 'true';
    const shouldAudit = MUTATING_METHODS.has(request.method) || isReveal;

    if (!shouldAudit) return next.handle();

    return next.handle().pipe(
      concatMap(async (responseBody: unknown) => {
        await this.writeAuditRow(request, responseBody, isReveal);
        return responseBody;
      }),
    );
  }

  private async writeAuditRow(
    request: AuthenticatedRequest,
    responseBody: unknown,
    isReveal: boolean,
  ): Promise<void> {
    const store = this.context.store;
    const tenantId = store?.tenantId;
    if (!tenantId) return; // public/unauthenticated routes (register, login) audit themselves in-service

    const params = request.params as Record<string, string | undefined>;
    const action = isReveal
      ? 'pii.reveal'
      : `${this.entityFromPath(request.originalUrl)}.${request.method.toLowerCase()}`;

    try {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId,
            branchId: store?.branchId,
            userId: store?.userId,
            action,
            entityType: this.entityFromPath(request.originalUrl),
            entityId: this.firstUuid(params),
            after: this.safeJson(responseBody),
            ipAddress: store?.ipAddress,
            userAgent: store?.userAgent,
          },
        }),
      );
    } catch (err) {
      // Never fail a completed business action because the audit write failed —
      // but make the failure loud.
      this.logger.error(`audit_log write failed for ${action}`, err);
    }
  }

  private entityFromPath(url: string): string {
    // /api/v1/branches/:id/reservations?... → "reservations"
    const path = url.split('?')[0] ?? '';
    const segments = path.split('/').filter(Boolean);
    const nonIdSegments = segments.filter(
      (s) => !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(s) && s !== 'api' && !/^v\d+$/.test(s),
    );
    return nonIdSegments[nonIdSegments.length - 1] ?? 'unknown';
  }

  private firstUuid(params: Record<string, string | undefined>): string | undefined {
    const candidates = ['id', ...Object.keys(params)];
    for (const key of candidates) {
      const value = params[key];
      if (value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        return value;
      }
    }
    return undefined;
  }

  private safeJson(value: unknown): Prisma.InputJsonValue | undefined {
    try {
      return value === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
    } catch {
      return undefined;
    }
  }
}
