import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, SystemRole } from '../decorators/roles.decorator';
import { ErrorCode } from '../errors/error-codes';
import { AuthenticatedRequest } from '../types/request-context';

/**
 * Branch-aware role check. A user can hold different roles at different
 * branches (user_branch_roles); a role row with branchId = NULL grants the
 * role at every branch (owner/admin pattern).
 *
 * Routes without @Roles() pass through — JwtAuthGuard + TenantGuard have
 * already run.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<SystemRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) return false;

    // Branch scope comes from the route param when present (/branches/:branchId/...).
    const params = request.params as Record<string, string | undefined>;
    const branchId = params.branchId;

    const allowed = user.roles.some(
      (assignment) =>
        (required as string[]).includes(assignment.role) &&
        (assignment.branchId === null || branchId === undefined || assignment.branchId === branchId),
    );

    if (!allowed) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Insufficient role for this action',
      });
    }
    return true;
  }
}
