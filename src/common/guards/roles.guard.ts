import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BRANCH_OF_KEY, BranchOfMetadata } from '../decorators/branch-of.decorator';
import { PERMISSION_KEY, PermissionMetadata } from '../decorators/permission.decorator';
import { ROLES_KEY, SystemRole } from '../decorators/roles.decorator';
import { ErrorCode } from '../errors/error-codes';
import { PageAccessService } from '../permissions/page-access.service';
import { actionForMethod, PERMISSION_MODULES, permits } from '../permissions/permission-catalogue';
import { PermissionsService } from '../permissions/permissions.service';
import { ApiKeyPrincipal, AuthenticatedRequest, JwtPayload } from '../types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { RECORD_BRANCH } from './record-branch';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * The branch is the one in the URL (`/branches/:branchId/...`), or — for a
 * route addressed by a record's own id and marked `@BranchOf` — the branch
 * that record belongs to. A route with neither accepts the role held at any
 * branch, which is only right for tenant-wide records (guests, campaigns).
 *
 * Routes without `@Roles()` pass through — JwtAuthGuard + TenantGuard have
 * already run. A request signed in with an API key never does: see
 * `apiKeyMayRead`.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
    private readonly prisma: PrismaService,
    private readonly pageAccess: PageAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // An API key is checked whether or not the route names roles: a route
    // open to every signed-in person is not open to every key.
    if (request.user?.apiKey) return this.apiKeyMayRead(context, request, request.user.apiKey);

    const user = request.user;
    // Branch scope comes from the route param when present (/branches/:branchId/...),
    // else from the record the route is addressed by — looked up once, and only when needed.
    const params = request.params as Record<string, string | undefined>;
    let resolved: { branchId: string | undefined } | null = null;
    const branchOfRequest = async (): Promise<string | undefined> => {
      resolved ??= { branchId: params.branchId ?? (user ? await this.recordBranch(context, params, user.tenantId) : undefined) };
      return resolved.branchId;
    };

    const required = this.reflector.getAllAndOverride<SystemRole[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (required && required.length > 0) {
      if (!user) return false;
      const branchId = await branchOfRequest();
      const atThisBranch = (assignment: { branchId: string | null }) =>
        assignment.branchId === null || branchId === undefined || assignment.branchId === branchId;
      const allowed =
        user.roles.some((assignment) => (required as string[]).includes(assignment.role) && atThisBranch(assignment)) ||
        (await this.customRoleAllows(context, request, user.roles.filter(atThisBranch).map((assignment) => assignment.role)));
      if (!allowed) throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Insufficient role for this action' });
    }

    if (user) await this.assertWithinPageAccess(context, user, branchOfRequest);
    return true;
  }

  /**
   * Page Access: a staff role whose pages its branch manager has set reaches
   * only the permission modules those pages use (`PageAccessService`), so a
   * page taken away is closed on the server too, not just hidden. Checked
   * after the role check, on routes in a module; owners, managers and roles
   * nobody has set pages for are never limited by it.
   */
  private async assertWithinPageAccess(context: ExecutionContext, user: JwtPayload, branchOfRequest: () => Promise<string | undefined>): Promise<void> {
    const metadata = this.reflector.getAllAndOverride<PermissionMetadata | undefined>(PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (!metadata) return;
    const modules = await this.pageAccess.modulesForUser(user.tenantId, user, branchOfRequest);
    if (modules && !modules.has(metadata.module)) {
      const label = PERMISSION_MODULES.find((module) => module.key === metadata.module)?.label ?? metadata.module;
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: `None of your pages at this branch include ${label} — ask your manager for access` });
    }
  }

  /**
   * An API key reads, and only what it was given: the route must belong to a
   * module in the key's scopes (`@Permission`), be a GET, and — for a key
   * kept to one branch — be about that branch. Routes with no module (staff,
   * roles, security, backups, GDPR, integrations) are out of reach, and so is
   * revealing an ID document number.
   */
  private async apiKeyMayRead(context: ExecutionContext, request: AuthenticatedRequest, key: ApiKeyPrincipal): Promise<boolean> {
    const refuse = (message: string): never => {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message });
    };
    const metadata = this.reflector.getAllAndOverride<PermissionMetadata | undefined>(PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') refuse('API keys can only read');
    if (!metadata || (metadata.action ?? actionForMethod(method)) !== 'read') refuse('API keys can’t reach this');
    if (!key.scopes.includes(metadata!.module)) refuse(`This API key can’t read ${metadata!.module.replace('_', ' ')} — give it access on the Integrations page`);
    if ((request.query as Record<string, unknown> | undefined)?.reveal === 'true') refuse('API keys can’t reveal ID document numbers');

    if (key.branchId) {
      const params = request.params as Record<string, string | undefined>;
      const branchId = params.branchId ?? (await this.recordBranch(context, params, request.user!.tenantId));
      if (branchId !== undefined && branchId !== key.branchId) refuse('This API key is for another branch');
    }
    return true;
  }

  /** The branch of the record a `@BranchOf` route is addressed by; `undefined` when there's none to find (a malformed id is left to the route's own validation, a missing record to its 404). */
  private async recordBranch(context: ExecutionContext, params: Record<string, string | undefined>, tenantId: string): Promise<string | undefined> {
    const branchOf = this.reflector.getAllAndOverride<BranchOfMetadata | undefined>(BRANCH_OF_KEY, [context.getHandler(), context.getClass()]);
    const id = branchOf ? params[branchOf.param] : undefined;
    if (!branchOf || !id || !UUID.test(id)) return undefined;
    const found = await this.prisma.withTenant(tenantId, (tx) => RECORD_BRANCH[branchOf.record](tx, id));
    return found ?? undefined;
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
