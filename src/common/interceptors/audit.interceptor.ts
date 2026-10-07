import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedRequest } from '../types/request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records every `?reveal=true` read — the one way to see a guest's ID
 * document number unmasked — as `pii.reveal`: who, when, from where, and
 * which record. Never what was revealed: the audit trail must not become a
 * second, unencrypted copy of the numbers it guards.
 *
 * Changes aren't recorded here. Every service writes its own audit row for
 * what it changes, in the same transaction and in its own words; a generic
 * row per request on top of that would only double the trail. (This class
 * once tried to do both, reading the tenant from a request-scoped store that
 * was already gone by the time the response arrived, so for a long while it
 * recorded nothing at all — reveals included. It now reads the request.)
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = executionContext.switchToHttp().getRequest<AuthenticatedRequest>();
    const isReveal = request.method === 'GET' && (request.query as Record<string, unknown> | undefined)?.reveal === 'true';
    if (!isReveal) return next.handle();

    return next.handle().pipe(
      concatMap(async (responseBody: unknown) => {
        await this.recordReveal(request);
        return responseBody;
      }),
    );
  }

  private async recordReveal(request: AuthenticatedRequest): Promise<void> {
    const tenantId = request.tenantId ?? request.user?.tenantId;
    if (!tenantId || !request.user) return;

    const params = request.params as Record<string, string | undefined>;
    const path = (request.originalUrl.split('?')[0] ?? '').slice(0, 300);
    try {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId,
            branchId: params.branchId && UUID.test(params.branchId) ? params.branchId : undefined,
            // An API key is never let through to a reveal, so this is a person.
            userId: request.user!.apiKey ? undefined : request.user!.sub,
            action: 'pii.reveal',
            entityType: this.entityFromPath(path),
            entityId: Object.values(params).find((value) => value !== undefined && UUID.test(value)),
            after: { path },
            ipAddress: request.ip,
            userAgent: request.header('user-agent')?.slice(0, 500),
          },
        }),
      );
    } catch (err) {
      // The read has happened; failing it now would only hide that it did. Loud instead.
      this.logger.error(`audit_log write failed for pii.reveal on ${path}`, err);
    }
  }

  private entityFromPath(path: string): string {
    // /api/v1/guests/:id → "guests"
    const segments = path.split('/').filter((segment) => segment && !UUID.test(segment) && segment !== 'api' && !/^v\d+$/.test(segment));
    return segments[segments.length - 1] ?? 'unknown';
  }
}
