import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SystemRole } from '../decorators/roles.decorator';
import { ErrorCode } from '../errors/error-codes';
import { JwtPayload } from '../types/request-context';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { MANAGER_ONLY_PAGES, PAGE_CATALOGUE, PageDefinition, STAFF_ROLES, StaffRole, UNRESTRICTED_ROLES } from './page-catalogue';
import { permits } from './permission-catalogue';
import { PermissionsService, RoleGrant } from './permissions.service';

const TTL_MS = 60_000;
const PAGE_BY_KEY = new Map(PAGE_CATALOGUE.map((page) => [page.key, page]));

/** One role's line on Page Access. */
export interface RolePageAccess {
  roleId: string;
  name: string;
  isSystem: boolean;
  /** A manager has set this role's pages here; otherwise it has every page in `available`. */
  customised: boolean;
  /** The pages it could be given — what its role lets it open. */
  available: string[];
  /** Of those, the ones it can only look at. */
  viewOnly: string[];
  /** The pages it opens at this branch now. */
  pages: string[];
}

export interface PageAccessMatrix {
  pages: Array<Pick<PageDefinition, 'key' | 'label' | 'group' | 'feature'>>;
  managerOnly: readonly string[];
  roles: RolePageAccess[];
}

type Rows = Map<string, Map<string, string[]>>;

/**
 * Page Access: which dashboard pages each staff role opens at each branch.
 *
 * A role with no row at a branch has its default — every page it can open
 * (`page-catalogue.ts`). Once its branch manager sets its pages, two things
 * follow: the web app shows it only those (`GET /branches/:id/my-pages`), and
 * `RolesGuard` refuses it any permission module none of those pages uses
 * (`modulesForUser`). Owners and managers are never restricted.
 *
 * Rows are cached per tenant (cleared on every write, a minute at most
 * otherwise) because the guard asks on every request.
 */
@Injectable()
export class PageAccessService {
  private readonly cache = new Map<string, { loadedAt: number; rows: Rows }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /** The pages a role could be given: a built-in staff role's from the catalogue, a custom role's by what its permissions let it read. */
  availableFor(role: RoleGrant): PageDefinition[] {
    if (UNRESTRICTED_ROLES.includes(role.name)) return [...PAGE_CATALOGUE];
    if (role.isSystem) return PAGE_CATALOGUE.filter((page) => page.roles.includes(role.name as StaffRole));
    return PAGE_CATALOGUE.filter((page) => page.module !== null && permits(role.permissions, page.module, 'read'));
  }

  /** Of a role's pages, the ones it can only look at. */
  private viewOnlyFor(role: RoleGrant, pages: PageDefinition[]): string[] {
    return pages
      .filter((page) => {
        if (role.isSystem) return page.actRoles !== undefined && !page.actRoles.includes(role.name as StaffRole);
        if (page.actRoles === undefined || page.module === null) return false;
        const module = page.module;
        return !(['create', 'update', 'delete'] as const).some((action) => permits(role.permissions, module, action));
      })
      .map((page) => page.key);
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async rowsFor(tenantId: string): Promise<Rows> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.rows;
    const found = await this.prisma.withTenant(tenantId, (tx) => tx.branchPageAccess.findMany({ select: { branchId: true, roleId: true, pages: true } }));
    const rows: Rows = new Map();
    for (const row of found) {
      const byRole = rows.get(row.branchId) ?? new Map<string, string[]>();
      byRole.set(row.roleId, row.pages);
      rows.set(row.branchId, byRole);
    }
    this.cache.set(tenantId, { loadedAt: Date.now(), rows });
    return rows;
  }

  /** What a role opens at a branch: its set pages (still within what it can open), or every page it can open. */
  private effectivePages(role: RoleGrant, stored: string[] | undefined): string[] {
    const available = this.availableFor(role).map((page) => page.key);
    return stored === undefined ? available : available.filter((key) => stored.includes(key));
  }

  /**
   * The pages a signed-in person opens at a branch — null when nothing is
   * restricted for them there (an owner, or a manager of the branch).
   */
  async pagesForUser(tenantId: string, user: JwtPayload, branchId: string): Promise<string[] | null> {
    if (user.roles.some((a) => a.role === (SystemRole.Owner as string))) return null;
    const here = user.roles.filter((a) => a.branchId === null || a.branchId === branchId);
    if (here.some((a) => UNRESTRICTED_ROLES.includes(a.role))) return null;

    const [roles, rows] = await Promise.all([this.permissions.rolesFor(tenantId), this.rowsFor(tenantId)]);
    const pages = new Set<string>();
    for (const assignment of here) {
      const role = roles.get(assignment.role);
      if (!role) continue;
      for (const key of this.effectivePages(role, rows.get(branchId)?.get(role.id))) pages.add(key);
    }
    return PAGE_CATALOGUE.map((page) => page.key).filter((key) => pages.has(key));
  }

  /**
   * The permission modules a person's pages reach — at the branch a request
   * is about, or across their branches for a request about none. Null means
   * no Page Access restriction applies: an owner or manager, or a role its
   * manager hasn't set pages for. Only a restricted role is limited, so a
   * role nobody has touched works exactly as its role allows.
   */
  async modulesForUser(tenantId: string, user: JwtPayload, branchOfRequest: () => Promise<string | undefined>): Promise<Set<string> | null> {
    if (user.roles.some((a) => a.role === (SystemRole.Owner as string))) return null;
    const rows = await this.rowsFor(tenantId);
    // Nobody restricted anywhere at this tenant — the common case — so the
    // request's branch (a database read for a record's) isn't even needed.
    if (rows.size === 0) return null;

    const branchId = await branchOfRequest();
    if (user.roles.some((a) => UNRESTRICTED_ROLES.includes(a.role) && (a.branchId === null || branchId === undefined || a.branchId === branchId))) return null;
    const assignments = user.roles.filter((a) => branchId === undefined || a.branchId === null || a.branchId === branchId);
    if (assignments.length === 0) return null;

    const roles = await this.permissions.rolesFor(tenantId);
    const modules = new Set<string>();
    for (const assignment of assignments) {
      const role = roles.get(assignment.role);
      if (!role) continue;
      const atBranch = branchId ?? assignment.branchId;
      if (atBranch === null) return null; // an every-branch role on a request about no branch: no one branch's setting to go by
      const stored = rows.get(atBranch)?.get(role.id);
      if (stored === undefined) return null;
      for (const key of stored) for (const module of PAGE_BY_KEY.get(key)?.uses ?? []) modules.add(module);
    }
    return modules;
  }

  /** Every staff role's pages at a branch, for Page Access. */
  async matrix(tenantId: string, branchId: string): Promise<PageAccessMatrix> {
    await this.assertBranch(tenantId, branchId);
    const [roles, rows] = await Promise.all([this.permissions.rolesFor(tenantId), this.rowsFor(tenantId)]);
    const staff = [...roles.values()]
      .filter((role) => !UNRESTRICTED_ROLES.includes(role.name))
      .sort((a, b) => {
        const order = (role: RoleGrant) => (role.isSystem ? STAFF_ROLES.indexOf(role.name as StaffRole) : STAFF_ROLES.length);
        return order(a) - order(b) || a.name.localeCompare(b.name);
      });
    return {
      pages: PAGE_CATALOGUE.map(({ key, label, group, feature }) => ({ key, label, group, feature })),
      managerOnly: MANAGER_ONLY_PAGES,
      roles: staff.map((role) => {
        const available = this.availableFor(role);
        const stored = rows.get(branchId)?.get(role.id);
        return {
          roleId: role.id,
          name: role.name,
          isSystem: role.isSystem,
          customised: stored !== undefined,
          available: available.map((page) => page.key),
          viewOnly: this.viewOnlyFor(role, available),
          pages: this.effectivePages(role, stored),
        };
      }),
    };
  }

  /** Set the pages one staff role opens at a branch. Only pages its role lets it open can be given. */
  async setPages(tenantId: string, branchId: string, roleId: string, pages: string[], actorId: string): Promise<RolePageAccess> {
    const role = await this.staffRole(tenantId, roleId);
    const available = new Set(this.availableFor(role).map((page) => page.key));
    const unknown = pages.find((key) => !PAGE_BY_KEY.has(key));
    if (unknown) throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `“${unknown}” isn’t a page Page Access covers` });
    const notAllowed = pages.find((key) => !available.has(key));
    if (notAllowed) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: `${PAGE_BY_KEY.get(notAllowed)!.label} can’t be given to this role — what the role is allowed to do doesn’t cover it`,
      });
    }
    const ordered = PAGE_CATALOGUE.map((page) => page.key).filter((key) => pages.includes(key));

    await this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertBranchInTx(tx, branchId);
      const before = await tx.branchPageAccess.findUnique({ where: { branchId_roleId: { branchId, roleId } } });
      await tx.branchPageAccess.upsert({
        where: { branchId_roleId: { branchId, roleId } },
        create: { tenantId, branchId, roleId, pages: ordered, updatedBy: actorId },
        update: { pages: ordered, updatedBy: actorId },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId,
          userId: actorId,
          action: 'page_access.updated',
          entityType: 'role',
          entityId: roleId,
          before: { role: role.name, pages: before?.pages ?? 'default' },
          after: { role: role.name, pages: ordered },
        },
      });
    });
    this.invalidate(tenantId);
    return (await this.matrix(tenantId, branchId)).roles.find((line) => line.roleId === roleId)!;
  }

  /** Back to the role's default: every page it can open. */
  async reset(tenantId: string, branchId: string, roleId: string, actorId: string): Promise<RolePageAccess> {
    const role = await this.staffRole(tenantId, roleId);
    await this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertBranchInTx(tx, branchId);
      const { count } = await tx.branchPageAccess.deleteMany({ where: { branchId, roleId } });
      if (count > 0) {
        await tx.auditLog.create({
          data: { tenantId, branchId, userId: actorId, action: 'page_access.reset', entityType: 'role', entityId: roleId, after: { role: role.name } },
        });
      }
    });
    this.invalidate(tenantId);
    return (await this.matrix(tenantId, branchId)).roles.find((line) => line.roleId === roleId)!;
  }

  private async staffRole(tenantId: string, roleId: string): Promise<RoleGrant> {
    const role = [...(await this.permissions.rolesFor(tenantId)).values()].find((candidate) => candidate.id === roleId);
    if (!role) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Role not found' });
    if (UNRESTRICTED_ROLES.includes(role.name)) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Owners and managers always see every page' });
    }
    return role;
  }

  private async assertBranch(tenantId: string, branchId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) => this.assertBranchInTx(tx, branchId));
  }

  private async assertBranchInTx(tx: TenantTx, branchId: string): Promise<void> {
    const branch = await tx.branch.findFirst({ where: { id: branchId, deletedAt: null }, select: { id: true } });
    if (!branch) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Branch not found' });
  }
}
