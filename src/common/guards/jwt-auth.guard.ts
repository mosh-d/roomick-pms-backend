import { BadRequestException, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { ApiKeyAuthService, presentedApiKey } from '../auth/api-key-auth.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ErrorCode } from '../errors/error-codes';
import { AuthenticatedRequest } from '../types/request-context';

/**
 * Global default: every route requires a valid access JWT unless marked @Public().
 *
 * An API key (`Authorization: Bearer rk_…` or `X-API-Key`) is the one other
 * way in: it signs the request in as the key, not as a person, and
 * `RolesGuard` then limits it to reading what the key was given.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyAuthService,
  ) {
    super();
  }

  override canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rawKey = presentedApiKey(request);
    if (rawKey !== null) return this.signInWithApiKey(request, rawKey);
    return super.canActivate(context);
  }

  private async signInWithApiKey(request: AuthenticatedRequest, rawKey: string): Promise<boolean> {
    const tenantId = request.header('X-Tenant-ID');
    if (!tenantId) {
      throw new BadRequestException({ code: ErrorCode.TENANT_HEADER_MISSING, message: 'X-Tenant-ID header is required' });
    }
    const key = await this.apiKeys.authenticate(tenantId, rawKey);
    if (!key) {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'This API key isn’t valid for this account — it may have been revoked' });
    }
    request.user = { sub: key.id, tenantId, email: '', roles: [], tokenType: 'access', apiKey: key };
    return true;
  }
}
