import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccountStatusService } from '../../common/auth/account-status.service';
import { AccountMailService } from '../../common/mail/account-mail.service';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { UsersService } from './users.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_BRANCH = '77777777-7777-4777-8777-777777777777';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const ROLE_ID = '55555555-5555-4555-8555-555555555555';

const OWNER: JwtPayload = { sub: ACTOR_ID, tenantId: TENANT_ID, email: 'o@x.test', roles: [{ branchId: null, role: 'owner' }], tokenType: 'access' };
const MANAGER: JwtPayload = { sub: ACTOR_ID, tenantId: TENANT_ID, email: 'm@x.test', roles: [{ branchId: BRANCH_ID, role: 'manager' }], tokenType: 'access' };

function makeTx() {
  return {
    branch: { findFirst: jest.fn().mockResolvedValue({ id: BRANCH_ID, name: 'Lekki' }) },
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ groupName: 'Acme Hotels' }) },
    role: { findMany: jest.fn(), findFirst: jest.fn() },
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirstOrThrow: jest.fn().mockResolvedValue({
        id: USER_ID,
        email: 's@d.l',
        name: 'Staff',
        phone: null,
        emailVerified: true,
        lastLoginAt: null,
        deletedAt: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    userBranchRole: {
      // What the person being changed holds — front desk at the manager's branch unless a test says otherwise.
      findMany: jest.fn().mockResolvedValue([{ userId: USER_ID, branchId: BRANCH_ID, role: { id: ROLE_ID, name: 'front_desk' } }]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({}),
    },
    userOutlet: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    outlet: { findMany: jest.fn().mockResolvedValue([]) },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    inviteToken: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockImplementation(({ data }: { data: { email: string } }) =>
        Promise.resolve({ id: `inv-${data.email}`, ...data }),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('UsersService', () => {
  let service: UsersService;
  let tx: ReturnType<typeof makeTx>;
  let mail: { staffInvite: jest.Mock };
  let accountStatus: { forget: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    mail = { staffInvite: jest.fn().mockResolvedValue(false) };
    accountStatus = { forget: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaService,
          useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) },
        },
        {
          provide: AuthService,
          useValue: {
            createInviteSecret: jest
              .fn()
              .mockReturnValue({ secret: 's'.repeat(96), publicToken: `${TENANT_ID}.${'s'.repeat(96)}` }),
          },
        },
        { provide: AccountMailService, useValue: mail },
        { provide: AccountStatusService, useValue: accountStatus },
      ],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  describe('bulkInvite', () => {
    it('creates one invite row per email and returns public tokens and the links to hand over', async () => {
      tx.role.findMany.mockResolvedValue([{ id: ROLE_ID, name: 'front_desk' }]);
      const result = await service.bulkInvite(OWNER, BRANCH_ID, { invites: [{ email: 'a@x.test', roleId: ROLE_ID }, { email: 'b@x.test', roleId: ROLE_ID }] });
      expect(tx.inviteToken.create).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
      expect(result[0].publicToken.startsWith(`${TENANT_ID}.`)).toBe(true);
      expect(result[0].link).toContain(`/accept-invite?token=${encodeURIComponent(result[0].publicToken)}`);
      expect(result.every((r) => r.emailed === false)).toBe(true);
    });

    it('emails each invitation after the rows are written, and says which went', async () => {
      tx.role.findMany.mockResolvedValue([{ id: ROLE_ID, name: 'front_desk' }]);
      mail.staffInvite.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const result = await service.bulkInvite(OWNER, BRANCH_ID, { invites: [{ email: 'a@x.test', roleId: ROLE_ID }, { email: 'b@x.test', roleId: ROLE_ID }] });
      expect(mail.staffInvite).toHaveBeenCalledWith('a@x.test', expect.objectContaining({ organisation: 'Acme Hotels', branch: 'Lekki', role: 'front desk', link: result[0].link }));
      expect(result.map((r) => r.emailed)).toEqual([true, false]);
    });

    it('replaces still-pending invites for the same email+role+branch (single-use)', async () => {
      tx.role.findMany.mockResolvedValue([{ id: ROLE_ID, name: 'front_desk' }]);
      await service.bulkInvite(OWNER, BRANCH_ID, { invites: [{ email: 'a@x.test', roleId: ROLE_ID }] });
      expect(tx.inviteToken.deleteMany).toHaveBeenCalledWith({
        where: { email: 'a@x.test', roleId: ROLE_ID, branchId: BRANCH_ID, acceptedAt: null },
      });
    });

    it('rejects unknown roleIds', async () => {
      tx.role.findMany.mockResolvedValue([]);
      await expect(service.bulkInvite(OWNER, BRANCH_ID, { invites: [{ email: 'a@x.test', roleId: ROLE_ID }] })).rejects.toThrow(BadRequestException);
      expect(tx.inviteToken.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown branch', async () => {
      tx.branch.findFirst.mockResolvedValue(null);
      await expect(service.bulkInvite(OWNER, BRANCH_ID, { invites: [{ email: 'a@x.test', roleId: ROLE_ID }] })).rejects.toThrow(NotFoundException);
    });

    it('never invites anyone as owner — not even the owner can', async () => {
      tx.role.findMany.mockResolvedValue([{ id: ROLE_ID, name: 'owner' }]);
      await expect(service.bulkInvite(OWNER, BRANCH_ID, { invites: [{ email: 'a@x.test', roleId: ROLE_ID }] })).rejects.toThrow(ForbiddenException);
      expect(tx.inviteToken.create).not.toHaveBeenCalled();
    });

    it('lets only the owner invite a manager', async () => {
      tx.role.findMany.mockResolvedValue([{ id: ROLE_ID, name: 'manager' }]);
      await expect(service.bulkInvite(MANAGER, BRANCH_ID, { invites: [{ email: 'a@x.test', roleId: ROLE_ID }] })).rejects.toThrow(ForbiddenException);
      await expect(service.bulkInvite(OWNER, BRANCH_ID, { invites: [{ email: 'a@x.test', roleId: ROLE_ID }] })).resolves.toHaveLength(1);
    });

    it('lets a manager invite staff only to a branch they manage', async () => {
      tx.role.findMany.mockResolvedValue([{ id: ROLE_ID, name: 'front_desk' }]);
      await expect(service.bulkInvite(MANAGER, BRANCH_ID, { invites: [{ email: 'a@x.test', roleId: ROLE_ID }] })).resolves.toHaveLength(1);
      await expect(service.bulkInvite(MANAGER, OTHER_BRANCH, { invites: [{ email: 'a@x.test', roleId: ROLE_ID }] })).rejects.toThrow(ForbiddenException);
    });

    it('points a deactivated person to reactivation instead', async () => {
      tx.role.findMany.mockResolvedValue([{ id: ROLE_ID, name: 'front_desk' }]);
      tx.user.findMany.mockResolvedValue([{ email: 'gone@x.test' }]);
      await expect(service.bulkInvite(OWNER, BRANCH_ID, { invites: [{ email: 'gone@x.test', roleId: ROLE_ID }] })).rejects.toThrow(ConflictException);
      expect(tx.inviteToken.create).not.toHaveBeenCalled();
    });
  });

  describe('pending invitations', () => {
    const pending = (role: string) => ({
      id: 'inv-1',
      email: 'a@x.test',
      roleId: ROLE_ID,
      branchId: BRANCH_ID,
      token: 't'.repeat(96),
      role: { name: role },
      invitedByUser: { name: 'Ada' },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() - 1000),
    });

    it('lists them with their links — expired ones too, marked', async () => {
      tx.inviteToken.findMany.mockResolvedValue([pending('front_desk')]);
      const [invite] = await service.listInvites(MANAGER, BRANCH_ID);
      expect(invite.expired).toBe(true);
      expect(invite.invitedBy).toBe('Ada');
      expect(invite.link).toContain(encodeURIComponent(`${TENANT_ID}.${'t'.repeat(96)}`));
    });

    it('never shows a manager the link to a manager’s invitation', async () => {
      tx.inviteToken.findMany.mockResolvedValue([pending('manager')]);
      const [asManager] = await service.listInvites(MANAGER, BRANCH_ID);
      expect(asManager.link).toBeNull();
      const [asOwner] = await service.listInvites(OWNER, BRANCH_ID);
      expect(asOwner.link).not.toBeNull();
    });

    it('withdraws one only for someone who could have made it', async () => {
      tx.inviteToken.findFirst.mockResolvedValue(pending('manager'));
      await expect(service.cancelInvite(MANAGER, 'inv-1')).rejects.toThrow(ForbiddenException);
      expect(tx.inviteToken.delete).not.toHaveBeenCalled();
      await expect(service.cancelInvite(OWNER, 'inv-1')).resolves.toEqual({ cancelled: true });
      expect(tx.inviteToken.delete).toHaveBeenCalledWith({ where: { id: 'inv-1' } });
    });
  });

  describe('patchStaff', () => {
    beforeEach(() => {
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, deletedAt: null });
    });

    it('requires at least one change', async () => {
      await expect(service.patchStaff(OWNER, USER_ID, {})).rejects.toThrow(BadRequestException);
    });

    it('deactivates via soft delete, never hard delete — and ends their sessions', async () => {
      await service.patchStaff(MANAGER, USER_ID, { active: false });
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { deletedAt: expect.any(Date) },
      });
      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: USER_ID, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
      expect(accountStatus.forget).toHaveBeenCalledWith(USER_ID); // their current access token is refused from now
    });

    it('replaces the role assignment at the given branch scope', async () => {
      tx.role.findFirst.mockResolvedValue({ id: ROLE_ID, name: 'housekeeper' });
      await service.patchStaff(MANAGER, USER_ID, { roleId: ROLE_ID, branchId: BRANCH_ID });
      expect(tx.userBranchRole.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, branchId: BRANCH_ID },
      });
      expect(tx.userBranchRole.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ roleId: ROLE_ID, branchId: BRANCH_ID, assignedBy: ACTOR_ID }),
        }),
      );
    });

    it('rejects outletIds without a branchId scope', async () => {
      await expect(service.patchStaff(OWNER, USER_ID, { outletIds: [ROLE_ID] })).rejects.toThrow(BadRequestException);
    });

    it('won’t let anyone change their own role or switch their own account off', async () => {
      tx.role.findFirst.mockResolvedValue({ id: ROLE_ID, name: 'owner' });
      await expect(service.patchStaff(MANAGER, ACTOR_ID, { roleId: ROLE_ID, branchId: BRANCH_ID })).rejects.toThrow(ForbiddenException);
      await expect(service.patchStaff(OWNER, ACTOR_ID, { active: false })).rejects.toThrow(ForbiddenException);
      expect(tx.userBranchRole.create).not.toHaveBeenCalled();
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('won’t let a manager make anyone a manager or owner', async () => {
      tx.role.findFirst.mockResolvedValue({ id: ROLE_ID, name: 'manager' });
      await expect(service.patchStaff(MANAGER, USER_ID, { roleId: ROLE_ID, branchId: BRANCH_ID })).rejects.toThrow(ForbiddenException);
      tx.role.findFirst.mockResolvedValue({ id: ROLE_ID, name: 'owner' });
      await expect(service.patchStaff(OWNER, USER_ID, { roleId: ROLE_ID, branchId: BRANCH_ID })).rejects.toThrow(ForbiddenException);
      expect(tx.userBranchRole.create).not.toHaveBeenCalled();
    });

    it('won’t let a manager touch another manager’s or the owner’s account', async () => {
      tx.userBranchRole.findMany.mockResolvedValue([{ userId: USER_ID, branchId: BRANCH_ID, role: { id: ROLE_ID, name: 'manager' } }]);
      await expect(service.patchStaff(MANAGER, USER_ID, { active: false })).rejects.toThrow(ForbiddenException);
      tx.userBranchRole.findMany.mockResolvedValue([{ userId: USER_ID, branchId: null, role: { id: ROLE_ID, name: 'owner' } }]);
      await expect(service.patchStaff(OWNER, USER_ID, { active: false })).rejects.toThrow(ForbiddenException);
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('keeps a manager to their own branches — a role elsewhere, or across every branch, is the owner’s', async () => {
      tx.role.findFirst.mockResolvedValue({ id: ROLE_ID, name: 'housekeeper' });
      await expect(service.patchStaff(MANAGER, USER_ID, { roleId: ROLE_ID, branchId: OTHER_BRANCH })).rejects.toThrow(ForbiddenException);
      await expect(service.patchStaff(MANAGER, USER_ID, { roleId: ROLE_ID })).rejects.toThrow(ForbiddenException);
      await expect(service.patchStaff(OWNER, USER_ID, { roleId: ROLE_ID })).resolves.toBeDefined();
    });

    it('leaves deactivating someone who also works elsewhere to the owner', async () => {
      tx.userBranchRole.findMany.mockResolvedValue([
        { userId: USER_ID, branchId: BRANCH_ID, role: { id: ROLE_ID, name: 'front_desk' } },
        { userId: USER_ID, branchId: OTHER_BRANCH, role: { id: ROLE_ID, name: 'front_desk' } },
      ]);
      await expect(service.patchStaff(MANAGER, USER_ID, { active: false })).rejects.toThrow(ForbiddenException);
      await expect(service.patchStaff(OWNER, USER_ID, { active: false })).resolves.toBeDefined();
    });
  });

  describe('setUserOutlets', () => {
    it('validates outlets belong to the branch before replacing', async () => {
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, deletedAt: null });
      tx.outlet.findMany.mockResolvedValue([]); // requested outlet not at branch
      await expect(
        service.setUserOutlets(OWNER, USER_ID, { branchId: BRANCH_ID, outletIds: ['66666666-6666-4666-8666-666666666666'] }),
      ).rejects.toThrow(BadRequestException);
      expect(tx.userOutlet.deleteMany).not.toHaveBeenCalled();
    });

    it('replaces assignments atomically (delete then createMany)', async () => {
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, deletedAt: null });
      const OUTLET_ID = '66666666-6666-4666-8666-666666666666';
      tx.outlet.findMany.mockResolvedValue([{ id: OUTLET_ID }]);
      await service.setUserOutlets(MANAGER, USER_ID, { branchId: BRANCH_ID, outletIds: [OUTLET_ID] });
      expect(tx.userOutlet.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, branchId: BRANCH_ID },
      });
      expect(tx.userOutlet.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({ userId: USER_ID, outletId: OUTLET_ID, branchId: BRANCH_ID }),
        ],
      });
    });

    it('keeps a manager to the outlets of their own branch', async () => {
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, deletedAt: null });
      await expect(service.setUserOutlets(MANAGER, USER_ID, { branchId: OTHER_BRANCH, outletIds: [] })).rejects.toThrow(ForbiddenException);
      expect(tx.userOutlet.deleteMany).not.toHaveBeenCalled();
    });

    it('answers with the outlets at the branches the asker manages — not the person’s outlets elsewhere', async () => {
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, deletedAt: null });
      const OUTLET_ID = '66666666-6666-4666-8666-666666666666';
      tx.outlet.findMany.mockResolvedValue([{ id: OUTLET_ID }]);
      tx.userOutlet.findMany.mockResolvedValue([
        { userId: USER_ID, outletId: OUTLET_ID, outlet: { id: OUTLET_ID, branchId: BRANCH_ID } },
        { userId: USER_ID, outletId: 'elsewhere', outlet: { id: 'elsewhere', branchId: OTHER_BRANCH } },
      ]);
      const rows = await service.setUserOutlets(MANAGER, USER_ID, { branchId: BRANCH_ID, outletIds: [OUTLET_ID] });
      expect(rows.map((r) => r.outletId)).toEqual([OUTLET_ID]);
    });
  });

  describe('getUserOutlets', () => {
    it('shows a manager only the outlets at their own branches', async () => {
      tx.userOutlet.findMany.mockResolvedValue([
        { userId: USER_ID, outletId: 'here', outlet: { id: 'here', branchId: BRANCH_ID } },
        { userId: USER_ID, outletId: 'elsewhere', outlet: { id: 'elsewhere', branchId: OTHER_BRANCH } },
      ]);
      expect((await service.getUserOutlets(MANAGER, USER_ID)).map((r) => r.outletId)).toEqual(['here']);
      expect((await service.getUserOutlets(OWNER, USER_ID)).map((r) => r.outletId)).toEqual(['here', 'elsewhere']);
    });
  });

  describe('listStaff', () => {
    it('a branch that isn’t there is a 404 — not the all-branch staff under any id', async () => {
      tx.branch.findFirst.mockResolvedValueOnce(null);
      await expect(service.listStaff(TENANT_ID, OTHER_BRANCH, MANAGER)).rejects.toThrow(NotFoundException);
      expect(tx.userBranchRole.findMany).not.toHaveBeenCalled();
    });

    it('says, for each person, what the one asking may change', async () => {
      tx.userBranchRole.findMany
        .mockResolvedValueOnce([
          { branchId: BRANCH_ID, role: { id: ROLE_ID, name: 'front_desk' }, user: { id: USER_ID, email: 's@x', name: 'Sam', phone: null, emailVerified: true, lastLoginAt: null, deletedAt: null, mfaEnabledAt: null } },
          { branchId: BRANCH_ID, role: { id: 'r-m', name: 'manager' }, user: { id: 'boss', email: 'b@x', name: 'Bo', phone: null, emailVerified: true, lastLoginAt: null, deletedAt: null, mfaEnabledAt: null } },
        ])
        .mockResolvedValueOnce([
          { userId: USER_ID, branchId: BRANCH_ID, role: { name: 'front_desk' } },
          { userId: 'boss', branchId: BRANCH_ID, role: { name: 'manager' } },
        ]);
      const staff = await service.listStaff(TENANT_ID, BRANCH_ID, MANAGER);
      const sam = staff.find((s) => s.id === USER_ID)!;
      const bo = staff.find((s) => s.id === 'boss')!;
      expect([sam.canChangeRole, sam.canManageAccount]).toEqual([true, true]);
      expect([bo.canChangeRole, bo.canManageAccount]).toEqual([false, false]);
    });
  });
});
