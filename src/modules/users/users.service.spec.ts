import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { UsersService } from './users.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const ROLE_ID = '55555555-5555-4555-8555-555555555555';

function makeTx() {
  return {
    branch: { findFirst: jest.fn().mockResolvedValue({ id: BRANCH_ID }) },
    role: { findMany: jest.fn(), findFirst: jest.fn() },
    user: {
      findFirst: jest.fn(),
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
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({}),
    },
    userOutlet: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    outlet: { findMany: jest.fn().mockResolvedValue([]) },
    inviteToken: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockImplementation(({ data }: { data: { email: string } }) =>
        Promise.resolve({ id: `inv-${data.email}`, ...data }),
      ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('UsersService', () => {
  let service: UsersService;
  let tx: ReturnType<typeof makeTx>;

  beforeEach(async () => {
    tx = makeTx();
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
      ],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  describe('bulkInvite', () => {
    it('creates one invite row per email and returns public tokens', async () => {
      tx.role.findMany.mockResolvedValue([{ id: ROLE_ID }]);
      const result = await service.bulkInvite(
        TENANT_ID,
        BRANCH_ID,
        { invites: [{ email: 'a@x.test', roleId: ROLE_ID }, { email: 'b@x.test', roleId: ROLE_ID }] },
        ACTOR_ID,
      );
      expect(tx.inviteToken.create).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
      expect(result[0].publicToken.startsWith(`${TENANT_ID}.`)).toBe(true);
    });

    it('replaces still-pending invites for the same email+role+branch (single-use)', async () => {
      tx.role.findMany.mockResolvedValue([{ id: ROLE_ID }]);
      await service.bulkInvite(
        TENANT_ID,
        BRANCH_ID,
        { invites: [{ email: 'a@x.test', roleId: ROLE_ID }] },
        ACTOR_ID,
      );
      expect(tx.inviteToken.deleteMany).toHaveBeenCalledWith({
        where: { email: 'a@x.test', roleId: ROLE_ID, branchId: BRANCH_ID, acceptedAt: null },
      });
    });

    it('rejects unknown roleIds', async () => {
      tx.role.findMany.mockResolvedValue([]);
      await expect(
        service.bulkInvite(
          TENANT_ID,
          BRANCH_ID,
          { invites: [{ email: 'a@x.test', roleId: ROLE_ID }] },
          ACTOR_ID,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(tx.inviteToken.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown branch', async () => {
      tx.branch.findFirst.mockResolvedValue(null);
      await expect(
        service.bulkInvite(
          TENANT_ID,
          BRANCH_ID,
          { invites: [{ email: 'a@x.test', roleId: ROLE_ID }] },
          ACTOR_ID,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('patchStaff', () => {
    beforeEach(() => {
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, deletedAt: null });
    });

    it('requires at least one change', async () => {
      await expect(service.patchStaff(TENANT_ID, USER_ID, {}, ACTOR_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('deactivates via soft delete, never hard delete', async () => {
      await service.patchStaff(TENANT_ID, USER_ID, { active: false }, ACTOR_ID);
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('replaces the role assignment at the given branch scope', async () => {
      tx.role.findFirst.mockResolvedValue({ id: ROLE_ID });
      await service.patchStaff(
        TENANT_ID,
        USER_ID,
        { roleId: ROLE_ID, branchId: BRANCH_ID },
        ACTOR_ID,
      );
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
      await expect(
        service.patchStaff(TENANT_ID, USER_ID, { outletIds: [ROLE_ID] }, ACTOR_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('setUserOutlets', () => {
    it('validates outlets belong to the branch before replacing', async () => {
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, deletedAt: null });
      tx.outlet.findMany.mockResolvedValue([]); // requested outlet not at branch
      await expect(
        service.setUserOutlets(
          TENANT_ID,
          USER_ID,
          { branchId: BRANCH_ID, outletIds: ['66666666-6666-4666-8666-666666666666'] },
          ACTOR_ID,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(tx.userOutlet.deleteMany).not.toHaveBeenCalled();
    });

    it('replaces assignments atomically (delete then createMany)', async () => {
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, deletedAt: null });
      const OUTLET_ID = '66666666-6666-4666-8666-666666666666';
      tx.outlet.findMany.mockResolvedValue([{ id: OUTLET_ID }]);
      await service.setUserOutlets(
        TENANT_ID,
        USER_ID,
        { branchId: BRANCH_ID, outletIds: [OUTLET_ID] },
        ACTOR_ID,
      );
      expect(tx.userOutlet.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, branchId: BRANCH_ID },
      });
      expect(tx.userOutlet.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({ userId: USER_ID, outletId: OUTLET_ID, branchId: BRANCH_ID }),
        ],
      });
    });
  });
});
