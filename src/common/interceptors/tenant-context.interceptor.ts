import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContextService } from '../context/tenant-context.service';
import { AuthenticatedRequest } from '../types/request-context';

/**
 * Populates the AsyncLocalStorage request context (tenant, user, ip, UA)
 * after the guards have validated the X-Tenant-ID ↔ JWT match.
 * The actual `SET LOCAL app.tenant_id` happens in PrismaService.withTenant —
 * per transaction, as the spec requires.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly context: TenantContextService) {}

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = executionContext.switchToHttp().getRequest<AuthenticatedRequest>();
    const params = request.params as Record<string, string | undefined>;

    return this.context.run(
      {
        tenantId: request.tenantId ?? request.user?.tenantId,
        userId: request.user?.sub,
        branchId: params.branchId,
        ipAddress: request.ip,
        userAgent: request.header('user-agent')?.slice(0, 500),
      },
      () => next.handle(),
    );
  }
}
