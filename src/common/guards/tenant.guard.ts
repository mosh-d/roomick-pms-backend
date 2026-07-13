import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ErrorCode } from '../errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedRequest } from '../types/request-context';

/**
 * Enforces spec §1.2(3): the X-Tenant-ID header must match the JWT's tenant
 * claim on every authenticated request — 403 otherwise. Mismatches are logged
 * to audit_log as security events.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) return false; // JwtAuthGuard runs first; belt and braces

    const headerTenantId = request.header('X-Tenant-ID');
    if (!headerTenantId) {
      throw new BadRequestException({
        code: ErrorCode.TENANT_HEADER_MISSING,
        message: 'X-Tenant-ID header is required',
      });
    }

    if (headerTenantId !== user.tenantId) {
      await this.logSecurityEvent(user.tenantId, user.sub, headerTenantId, request);
      throw new ForbiddenException({
        code: ErrorCode.TENANT_MISMATCH,
        message: 'Tenant context does not match credentials',
      });
    }

    request.tenantId = user.tenantId;
    return true;
  }

  private async logSecurityEvent(
    tenantId: string,
    userId: string,
    attemptedTenantId: string,
    request: AuthenticatedRequest,
  ): Promise<void> {
    try {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId,
            userId,
            action: 'security.cross_tenant_attempt',
            entityType: 'tenant',
            after: { attemptedTenantId, path: request.originalUrl, method: request.method },
            ipAddress: request.ip,
            userAgent: request.header('user-agent')?.slice(0, 500),
          },
        }),
      );
    } catch (err) {
      // The 403 must still be returned even if audit logging fails.
      this.logger.error('Failed to write cross-tenant audit row', err);
    }
  }
}
