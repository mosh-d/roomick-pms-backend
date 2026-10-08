import { BadRequestException, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { isObservable, lastValueFrom } from 'rxjs';
import { AccountStatusService } from '../auth/account-status.service';
import { ApiKeyAuthService, presentedApiKey } from '../auth/api-key-auth.service';
import { TENANT_SUSPENDED_MESSAGE } from '../auth/tenant-status';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ErrorCode } from '../errors/error-codes';
import { AuthenticatedRequest } from '../types/request-context';

/**
 * Global default: every route requires a valid access JWT unless marked @Public().
 *
 * A valid token isn't the whole answer: the account behind it must still be
 * open. A token outlives a deactivation (or the deletion of the whole
 * organisation) by up to fifteen minutes, and before this check those
 * requests got through the door and failed deeper in — a 500 where a 401
 * belonged. `AccountStatusService` remembers the answer briefly, so this
 * costs one indexed read per person every thirty seconds.
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
    private readonly accounts: AccountStatusService,
  ) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rawKey = presentedApiKey(request);
    if (rawKey !== null) return this.signInWithApiKey(request, rawKey);

    const verdict = super.canActivate(context);
    const tokenOk = isObservable(verdict) ? await lastValueFrom(verdict) : await verdict;
    if (!tokenOk || !request.user) return false;
    const { state, roles } = await this.accounts.current(request.user);
    if (state === 'suspended') {
      throw new ForbiddenException({ code: ErrorCode.TENANT_SUSPENDED, message: TENANT_SUSPENDED_MESSAGE });
    }
    if (state !== 'open') {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHORIZED, message: 'This account is no longer active — sign in again' });
    }
    // The roles held now, not when the token was issued — see AccountStatusService.
    if (roles) request.user = { ...request.user, roles };
    return true;
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
