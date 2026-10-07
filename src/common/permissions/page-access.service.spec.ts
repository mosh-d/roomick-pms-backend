import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../types/request-context';
import { PageAccessService } from './page-access.service';
import { PAGE_CATALOGUE } from './page-catalogue';
import { PermissionsService, RoleGrant } from './permissions.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_A = '22222222-2222-4222-8222-222222222222';
const BRANCH_B = '33333333-3333-4333-8333-333333333333';

const ROLES: RoleGrant[] = [
  { id: 'role-owner', name: 'owner', isSystem: true, permissions: {} },
  { id: 'role-manager', name: 'manager', isSystem: true, permissions: {} },
  { id: 'role-desk', name: 'front_desk', isSystem: true, permissions: {} },
  { id: 'role-hk', name: 'housekeeper', isSystem: true, permissions: {} },
  { id: 'role-acct', name: 'accountant', isSystem: true, permissions: {} },
  { id: 'role-pos', name: 'pos_staff', isSystem: true, permissions: {} },
  { id: 'role-night', name: 'Night Auditor', isSystem: false, permissions: { reservations: ['read'], night_audit: ['read', 'update'] } },
];

const person = (roles: Array<{ branchId: string | null; role: string }>): JwtPayload => ({ sub: 'user-1', tenantId: TENANT_ID, email: 'x@example.com', roles, tokenType: 'access' });

function setup(rows: Array<{ branchId: string; roleId: string; pages: string[] }> = []) {
  const stored = [...rows];
  const tx = {
    branchPageAccess: {
      findMany: jest.fn(() => Promise.resolve(stored)),
      findUnique: jest.fn(({ where }: { where: { branchId_roleId: { branchId: string; roleId: string } } }) =>
        Promise.resolve(stored.find((r) => r.branchId === where.branchId_roleId.branchId && r.roleId === where.branchId_roleId.roleId) ?? null),
      ),
      upsert: jest.fn(({ create }: { create: { branchId: string; roleId: string; pages: string[] } }) => {
        const i = stored.findIndex((r) => r.branchId === create.branchId && r.roleId === create.roleId);
        if (i >= 0) stored.splice(i, 1);
        stored.push({ branchId: create.branchId, roleId: create.roleId, pages: create.pages });
        return Promise.resolve({});
      }),
      deleteMany: jest.fn(({ where }: { where: { branchId: string; roleId: string } }) => {
        const before = stored.length;
        for (let i = stored.length - 1; i >= 0; i--) if (stored[i].branchId === where.branchId && stored[i].roleId === where.roleId) stored.splice(i, 1);
        return Promise.resolve({ count: before - stored.length });
      }),
    },
    branch: { findFirst: jest.fn().mockResolvedValue({ id: BRANCH_A }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
  const permissions = { rolesFor: jest.fn().mockResolvedValue(new Map(ROLES.map((r) => [r.name, r]))) } as unknown as PermissionsService;
  return { tx, service: new PageAccessService(prisma, permissions) };
}

const defaultsFor = (role: string) => PAGE_CATALOGUE.filter((page) => (page.roles as readonly string[]).includes(role)).map((page) => page.key);

describe('PageAccessService', () => {
  describe('what a role could be given', () => {
    it('a built-in staff role: the pages its role can open', () => {
      const { service } = setup();
      const keys = service.availableFor(ROLES[3]).map((page) => page.key);
      expect(keys).toContain('/dashboard/housekeeping/task-board');
      expect(keys).not.toContain('/dashboard/comms-log');
      expect(keys).not.toContain('/dashboard/reports/financial');
    });

    it('a custom role: the pages whose module its permissions let it read', () => {
      const { service } = setup();
      const keys = service.availableFor(ROLES[6]).map((page) => page.key);
      expect(keys).toContain('/dashboard/night-audit');
      expect(keys).toContain('/dashboard/arrivals');
      expect(keys).not.toContain('/dashboard/billing/folios');
      expect(keys).not.toContain('/dashboard/integrations/marketplace'); // no module — never a custom role's
    });
  });

  describe('the pages a person opens', () => {
    it('an owner, or a manager of the branch, is never restricted', async () => {
      const { service } = setup([{ branchId: BRANCH_A, roleId: 'role-desk', pages: [] }]);
      await expect(service.pagesForUser(TENANT_ID, person([{ branchId: null, role: 'owner' }]), BRANCH_A)).resolves.toBeNull();
      await expect(service.pagesForUser(TENANT_ID, person([{ branchId: BRANCH_A, role: 'manager' }]), BRANCH_A)).resolves.toBeNull();
    });

    it('a role nobody has set opens every page it can', async () => {
      const { service } = setup();
      await expect(service.pagesForUser(TENANT_ID, person([{ branchId: BRANCH_A, role: 'housekeeper' }]), BRANCH_A)).resolves.toEqual(defaultsFor('housekeeper'));
    });

    it('a role its manager set opens just those — at that branch only', async () => {
      const { service } = setup([{ branchId: BRANCH_A, roleId: 'role-hk', pages: ['/dashboard/housekeeping/task-board', '/dashboard/room-status-board'] }]);
      const housekeeper = person([{ branchId: null, role: 'housekeeper' }]);
      await expect(service.pagesForUser(TENANT_ID, housekeeper, BRANCH_A)).resolves.toEqual(['/dashboard/room-status-board', '/dashboard/housekeeping/task-board']);
      await expect(service.pagesForUser(TENANT_ID, housekeeper, BRANCH_B)).resolves.toEqual(defaultsFor('housekeeper'));
    });

    it('two roles at a branch open both roles’ pages', async () => {
      const { service } = setup([
        { branchId: BRANCH_A, roleId: 'role-hk', pages: ['/dashboard/housekeeping/task-board'] },
        { branchId: BRANCH_A, roleId: 'role-acct', pages: ['/dashboard/reports/financial'] },
      ]);
      const both = person([
        { branchId: BRANCH_A, role: 'housekeeper' },
        { branchId: BRANCH_A, role: 'accountant' },
      ]);
      await expect(service.pagesForUser(TENANT_ID, both, BRANCH_A)).resolves.toEqual(['/dashboard/housekeeping/task-board', '/dashboard/reports/financial']);
    });
  });

  describe('the modules a person reaches', () => {
    it('with nobody restricted anywhere, there is no limit — and the request’s branch is never looked up', async () => {
      const { service } = setup();
      const branchOfRequest = jest.fn();
      await expect(service.modulesForUser(TENANT_ID, person([{ branchId: BRANCH_A, role: 'front_desk' }]), branchOfRequest)).resolves.toBeNull();
      expect(branchOfRequest).not.toHaveBeenCalled();
    });

    it('a restricted role reaches the modules its pages use, and nothing else', async () => {
      const { service } = setup([{ branchId: BRANCH_A, roleId: 'role-hk', pages: ['/dashboard/housekeeping/task-board'] }]);
      const modules = await service.modulesForUser(TENANT_ID, person([{ branchId: BRANCH_A, role: 'housekeeper' }]), () => Promise.resolve(BRANCH_A));
      expect([...modules!].sort()).toEqual(['housekeeping', 'property']);
    });

    it('a role nobody set at that branch is not limited', async () => {
      const { service } = setup([{ branchId: BRANCH_A, roleId: 'role-hk', pages: [] }]);
      await expect(service.modulesForUser(TENANT_ID, person([{ branchId: null, role: 'housekeeper' }]), () => Promise.resolve(BRANCH_B))).resolves.toBeNull();
    });

    it('a manager there, or an owner, is never limited', async () => {
      const { service } = setup([{ branchId: BRANCH_A, roleId: 'role-desk', pages: [] }]);
      const managerAndDesk = person([
        { branchId: BRANCH_A, role: 'manager' },
        { branchId: BRANCH_A, role: 'front_desk' },
      ]);
      await expect(service.modulesForUser(TENANT_ID, managerAndDesk, () => Promise.resolve(BRANCH_A))).resolves.toBeNull();
    });

    it('a request about no branch: the restricted branches’ pages together — or no limit if any role there is unset', async () => {
      const { service } = setup([
        { branchId: BRANCH_A, roleId: 'role-desk', pages: ['/dashboard/comms-log'] },
        { branchId: BRANCH_B, roleId: 'role-desk', pages: ['/dashboard/guests/profiles'] },
      ]);
      const twoBranches = person([
        { branchId: BRANCH_A, role: 'front_desk' },
        { branchId: BRANCH_B, role: 'front_desk' },
      ]);
      const modules = await service.modulesForUser(TENANT_ID, twoBranches, () => Promise.resolve(undefined));
      expect([...modules!].sort()).toEqual(['comms', 'guests', 'loyalty', 'reservations']);
      const everyBranch = person([{ branchId: null, role: 'front_desk' }]);
      await expect(service.modulesForUser(TENANT_ID, everyBranch, () => Promise.resolve(undefined))).resolves.toBeNull();
    });
  });

  describe('setting a role’s pages', () => {
    it('saves them in the app’s order, audits before and after, and the next answer uses them', async () => {
      const { service, tx } = setup();
      const hk = person([{ branchId: BRANCH_A, role: 'housekeeper' }]);
      await service.pagesForUser(TENANT_ID, hk, BRANCH_A); // warms the cache
      const line = await service.setPages(TENANT_ID, BRANCH_A, 'role-hk', ['/dashboard/room-status-board', '/dashboard/alerts'], 'manager-1');

      expect(line).toMatchObject({ customised: true, pages: ['/dashboard/alerts', '/dashboard/room-status-board'] });
      expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'page_access.updated', before: { role: 'housekeeper', pages: 'default' }, after: { pages: ['/dashboard/alerts', '/dashboard/room-status-board'] } });
      await expect(service.pagesForUser(TENANT_ID, hk, BRANCH_A)).resolves.toEqual(['/dashboard/alerts', '/dashboard/room-status-board']);
    });

    it('refuses a page its role can’t open, a page that isn’t one, and owners or managers', async () => {
      const { service, tx } = setup();
      await expect(service.setPages(TENANT_ID, BRANCH_A, 'role-hk', ['/dashboard/comms-log'], 'm')).rejects.toThrow(/Comms Log can’t be given to this role/);
      await expect(service.setPages(TENANT_ID, BRANCH_A, 'role-hk', ['/dashboard/nowhere'], 'm')).rejects.toThrow(/isn’t a page/);
      await expect(service.setPages(TENANT_ID, BRANCH_A, 'role-manager', [], 'm')).rejects.toThrow(/always see every page/);
      expect(tx.branchPageAccess.upsert).not.toHaveBeenCalled();
    });

    it('reset puts the role back on its default', async () => {
      const { service, tx } = setup([{ branchId: BRANCH_A, roleId: 'role-acct', pages: [] }]);
      const line = await service.reset(TENANT_ID, BRANCH_A, 'role-acct', 'manager-1');
      expect(line).toMatchObject({ customised: false, pages: defaultsFor('accountant') });
      expect(tx.auditLog.create.mock.calls[0][0].data.action).toBe('page_access.reset');
    });

    it('the matrix lists the staff roles — never owners or managers — with what each is view-only on', async () => {
      const { service } = setup();
      const matrix = await service.matrix(TENANT_ID, BRANCH_A);
      expect(matrix.roles.map((r) => r.name)).toEqual(['front_desk', 'housekeeper', 'accountant', 'pos_staff', 'Night Auditor']);
      const hk = matrix.roles.find((r) => r.name === 'housekeeper')!;
      expect(hk.viewOnly).toContain('/dashboard/check-in');
      expect(hk.viewOnly).not.toContain('/dashboard/housekeeping/task-board');
      const night = matrix.roles.find((r) => r.name === 'Night Auditor')!;
      expect(night.viewOnly).toContain('/dashboard/check-in'); // reads reservations, can't change them
      expect(night.viewOnly).not.toContain('/dashboard/night-audit');
    });
  });
});
