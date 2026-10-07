import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BRANCH_OF_KEY, BranchOfMetadata } from '../decorators/branch-of.decorator';
import { PERMISSION_KEY, PermissionMetadata } from '../decorators/permission.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { ROLES_KEY, SystemRole } from '../decorators/roles.decorator';
import { PermissionMap } from '../permissions/permission-catalogue';
import { PermissionsService, RoleGrant } from '../permissions/permissions.service';
import { JwtPayload } from '../types/request-context';
import { RolesGuard } from './roles.guard';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_BRANCH_ID = '33333333-3333-4333-8333-333333333333';

function actor(roles: Array<{ branchId: string | null; role: string }>): JwtPayload {
  return { sub: 'user-1', tenantId: TENANT_ID, email: 'staff@example.com', roles, tokenType: 'access' };
}

function customRole(name: string, permissions: PermissionMap): RoleGrant {
  return { id: `role-${name}`, name, isSystem: false, permissions };
}

function contextFor(options: {
  required?: SystemRole[];
  permission?: PermissionMetadata;
  method?: string;
  params?: Record<string, string>;
  user?: JwtPayload;
  branchOf?: BranchOfMetadata;
}): { context: ExecutionContext; reflector: Reflector } {
  const request = { user: options.user, params: options.params ?? {}, method: options.method ?? 'GET' };
  const context = {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === ROLES_KEY ? options.required : key === PERMISSION_KEY ? options.permission : key === BRANCH_OF_KEY ? options.branchOf : undefined,
  } as unknown as Reflector;
  return { context, reflector };
}

/** A tenant whose folios live at the branches given (folio id → branch id). */
function prismaWith(folios: Record<string, string> = {}) {
  const tx = { folio: { findFirst: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(folios[where.id] ? { branchId: folios[where.id] } : null)) } };
  return { tx, prisma: { withTenant: jest.fn((_tenantId: string, fn: (t: unknown) => unknown) => fn(tx)) } as unknown as PrismaService };
}

function guardWith(reflector: Reflector, roles: RoleGrant[], prisma: PrismaService = prismaWith().prisma): RolesGuard {
  const permissionsService = { rolesFor: jest.fn().mockResolvedValue(new Map(roles.map((role) => [role.name, role]))) } as unknown as PermissionsService;
  return new RolesGuard(reflector, permissionsService, prisma);
}

describe('RolesGuard', () => {
  it('lets a route with no role requirement through', async () => {
    const { context, reflector } = contextFor({ user: actor([]) });
    await expect(guardWith(reflector, []).canActivate(context)).resolves.toBe(true);
  });

  describe('the seeded roles, as before', () => {
    it('passes a role named on the route', async () => {
      const { context, reflector } = contextFor({ required: [SystemRole.Manager], user: actor([{ branchId: BRANCH_ID, role: 'manager' }]), params: { branchId: BRANCH_ID } });
      await expect(guardWith(reflector, []).canActivate(context)).resolves.toBe(true);
    });

    it('refuses a role held only at another branch', async () => {
      const { context, reflector } = contextFor({ required: [SystemRole.Manager], user: actor([{ branchId: OTHER_BRANCH_ID, role: 'manager' }]), params: { branchId: BRANCH_ID } });
      await expect(guardWith(reflector, []).canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('passes a branchless assignment at any branch', async () => {
      const { context, reflector } = contextFor({ required: [SystemRole.Owner], user: actor([{ branchId: null, role: 'owner' }]), params: { branchId: BRANCH_ID } });
      await expect(guardWith(reflector, []).canActivate(context)).resolves.toBe(true);
    });

    it('never asks the database when a seeded role already matches', async () => {
      const { context, reflector } = contextFor({ required: [SystemRole.Owner], user: actor([{ branchId: null, role: 'owner' }]) });
      const permissionsService = { rolesFor: jest.fn() } as unknown as PermissionsService;
      await expect(new RolesGuard(reflector, permissionsService, prismaWith().prisma).canActivate(context)).resolves.toBe(true);
      expect((permissionsService as unknown as { rolesFor: jest.Mock }).rolesFor).not.toHaveBeenCalled();
    });
  });

  describe('a custom role', () => {
    const nightAuditor = customRole('Night Auditor', { reservations: ['read', 'update'], folios: ['read'] });

    it('reaches a route its permissions cover, action following the HTTP method', async () => {
      const { context, reflector } = contextFor({
        required: [SystemRole.Manager],
        permission: { module: 'reservations' },
        method: 'GET',
        user: actor([{ branchId: BRANCH_ID, role: 'Night Auditor' }]),
        params: { branchId: BRANCH_ID },
      });
      await expect(guardWith(reflector, [nightAuditor]).canActivate(context)).resolves.toBe(true);
    });

    it('is refused the action it wasn’t given', async () => {
      const { context, reflector } = contextFor({
        required: [SystemRole.Manager],
        permission: { module: 'reservations' },
        method: 'DELETE',
        user: actor([{ branchId: BRANCH_ID, role: 'Night Auditor' }]),
        params: { branchId: BRANCH_ID },
      });
      await expect(guardWith(reflector, [nightAuditor]).canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is refused a module it wasn’t given at all', async () => {
      const { context, reflector } = contextFor({
        required: [SystemRole.Manager],
        permission: { module: 'pos' },
        method: 'GET',
        user: actor([{ branchId: BRANCH_ID, role: 'Night Auditor' }]),
      });
      await expect(guardWith(reflector, [nightAuditor]).canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('honours a route that declares its own action — a POST that only reads', async () => {
      const { context, reflector } = contextFor({
        required: [SystemRole.Manager],
        permission: { module: 'folios', action: 'read' },
        method: 'POST',
        user: actor([{ branchId: BRANCH_ID, role: 'Night Auditor' }]),
      });
      await expect(guardWith(reflector, [nightAuditor]).canActivate(context)).resolves.toBe(true);
    });

    it('cannot reach a route that declares no module — staff, roles, security, backups, GDPR', async () => {
      const { context, reflector } = contextFor({
        required: [SystemRole.Owner],
        method: 'GET',
        user: actor([{ branchId: BRANCH_ID, role: 'Night Auditor' }]),
      });
      await expect(guardWith(reflector, [customRole('Night Auditor', { reservations: ['read'] })]).canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('only counts where it is held: the same role at another branch grants nothing here', async () => {
      const { context, reflector } = contextFor({
        required: [SystemRole.Manager],
        permission: { module: 'reservations' },
        method: 'GET',
        user: actor([{ branchId: OTHER_BRANCH_ID, role: 'Night Auditor' }]),
        params: { branchId: BRANCH_ID },
      });
      await expect(guardWith(reflector, [nightAuditor]).canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('grants nothing through a role that has since been deleted', async () => {
      const { context, reflector } = contextFor({
        required: [SystemRole.Manager],
        permission: { module: 'reservations' },
        user: actor([{ branchId: BRANCH_ID, role: 'Night Auditor' }]),
      });
      await expect(guardWith(reflector, []).canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('ignores a permission map on a seeded role — its access is what the routes say', async () => {
    // Somebody writes {reservations: [delete]} onto the manager role: it must
    // not widen what a manager can reach beyond the routes naming manager.
    const { context, reflector } = contextFor({
      required: [SystemRole.Owner],
      permission: { module: 'reservations' },
      method: 'DELETE',
      user: actor([{ branchId: BRANCH_ID, role: 'manager' }]),
    });
    const seeded: RoleGrant = { id: 'role-manager', name: 'manager', isSystem: true, permissions: { reservations: ['delete'] } };
    await expect(guardWith(reflector, [seeded]).canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('a route addressed by a record (@BranchOf)', () => {
    const FOLIO_HERE = '44444444-4444-4444-8444-444444444444';
    const FOLIO_THERE = '55555555-5555-4555-8555-555555555555';
    const route = (user: JwtPayload, folioId: string) =>
      contextFor({ required: [SystemRole.FrontDesk, SystemRole.Owner], user, params: { folioId }, method: 'POST', branchOf: { record: 'folio', param: 'folioId' } });
    const frontDesk = actor([{ branchId: BRANCH_ID, role: 'front_desk' }]);

    it("checks the role at the record's own branch: the desk's own bills pass, another property's don't", async () => {
      const { prisma } = prismaWith({ [FOLIO_HERE]: BRANCH_ID, [FOLIO_THERE]: OTHER_BRANCH_ID });
      const here = route(frontDesk, FOLIO_HERE);
      await expect(guardWith(here.reflector, [], prisma).canActivate(here.context)).resolves.toBe(true);
      const there = route(frontDesk, FOLIO_THERE);
      await expect(guardWith(there.reflector, [], prisma).canActivate(there.context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('an owner reaches every branch', async () => {
      const { prisma } = prismaWith({ [FOLIO_THERE]: OTHER_BRANCH_ID });
      const there = route(actor([{ branchId: null, role: 'owner' }]), FOLIO_THERE);
      await expect(guardWith(there.reflector, [], prisma).canActivate(there.context)).resolves.toBe(true);
    });

    it('a record that is not found is left to the route to 404, and a malformed id to its validation — no query for that', async () => {
      const { prisma, tx } = prismaWith();
      const missing = route(frontDesk, FOLIO_HERE);
      await expect(guardWith(missing.reflector, [], prisma).canActivate(missing.context)).resolves.toBe(true);
      const malformed = route(frontDesk, 'not-a-uuid');
      await expect(guardWith(malformed.reflector, [], prisma).canActivate(malformed.context)).resolves.toBe(true);
      expect(tx.folio.findFirst).toHaveBeenCalledTimes(1);
    });
  });
});
