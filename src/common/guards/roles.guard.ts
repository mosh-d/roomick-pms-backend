import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY, PermissionMetadata } from '../decorators/permission.decorator';
import { ROLES_KEY, SystemRole } from '../decorators/roles.decorator';
import { ErrorCode } from '../errors/error-codes';
import { actionForMethod, permits } from '../permissions/permission-catalogue';
import { PermissionsService } from '../permissions/permissions.service';
import { AuthenticatedRequest } from '../types/request-context';

/**
 * Branch-aware authorisation. A user can hold different roles at different
 * branches (user_branch_roles); a role row with branchId = NULL grants the
 * role at every branch (owner/admin pattern).
 *
 * Two ways through, checked in this order:
 *
 *  1. **A seeded role named on the route** — unchanged since the MVP, and
 *     still the path every owner, manager, front desk, housekeeper,
 *     accountant and POS user takes. No database read.
 *  2. **A custom role whose permissions cover this route** — the route says
 *     which module it belongs to with `@Permission`, the action follows the
 *     HTTP method unless the route overrides it, and the role's own map is
 *     consulted. A route with no `@Permission` has no module, so no custom
 *     role can reach it: staff, roles, security, system administration,
 *     backups, GDPR and integrations are off limits to invented roles by
 *     construction, not by configuration.
 *
 * Routes without `@Roles()` pass through — JwtAuthGuard + TenantGuard have
 * already run.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<SystemRole[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) return false;

    // Branch scope comes from the route param when present (/branches/:branchId/...).
    const params = request.params as Record<string, string | undefined>;
    const branchId = params.branchId;
    const atThisBranch = (assignment: { branchId: string | null }) =>
      assignment.branchId === null || branchId === undefined || assignment.branchId === branchId;

    if (user.roles.some((assignment) => (required as string[]).includes(assignment.role) && atThisBranch(assignment))) {
      return true;
    }

    if (await this.customRoleAllows(context, request, user.roles.filter(atThisBranch).map((assignment) => assignment.role))) {
      return true;
    }

    throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Insufficient role for this action' });
  }

  private async customRoleAllows(context: ExecutionContext, request: AuthenticatedRequest, roleNames: string[]): Promise<boolean> {
    if (roleNames.length === 0) return false;
    const metadata = this.reflector.getAllAndOverride<PermissionMetadata | undefined>(PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (!metadata) return false;

    const action = metadata.action ?? actionForMethod(request.method);
    const roles = await this.permissionsService.rolesFor(request.user!.tenantId);
    return roleNames.some((name) => {
      const role = roles.get(name);
      // Seeded roles are the name check above and nothing else: their access
      // is what the routes say it is, not what a permission map says.
      return role !== undefined && !role.isSystem && permits(role.permissions, metadata.module, action);
    });
  }
}
