import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService, SYSTEM_ROLE_NAMES } from './auth.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn(),
}));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function makeTx(): Record<string, Record<string, jest.Mock>> {
  return {
    role: {
      createMany: jest.fn().mockResolvedValue({ count: 6 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'role-owner', name: 'owner' }),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    user: {
      create: jest.fn().mockResolvedValue({ id: USER_ID, tenantId: TENANT_ID, email: 'a@b.c', name: 'A' }),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    userBranchRole: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([{ branchId: null, role: { name: 'owner' } }]),
    },
    inviteToken: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    userEmailIndex: {
      // register()'s and acceptInvite()'s cross-tenant-guard writes — both
      // run via `tx`, inside the same transaction as user creation, not
      // the top-level `prisma` client (see auth.service.ts's own comment
      // on why: atomicity, not RLS — the table isn't RLS-scoped at all).
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let tx: ReturnType<typeof makeTx>;
  let prisma: {
    tenant: { findUnique: jest.Mock; create: jest.Mock };
    userEmailIndex: { findUnique: jest.Mock; create: jest.Mock };
    withTenant: jest.Mock;
  };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    prisma = {
      tenant: {
        // Doubles as generateUniqueSubdomain()'s collision check in
        // register() now — null (no collision) is the correct happy-path
        // default for both callers.
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: TENANT_ID, subdomain: 'acme' }),
      },
      userEmailIndex: {
        // register()'s and login()'s pre-checks run against the top-level
        // client, not `tx` — null (no existing account) is the correct
        // happy-path default; individual tests override for collisions.
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      withTenant: jest.fn((_tenantId: string, fn: (t: unknown) => unknown) => fn(tx)),
    };
    jwt = {
      signAsync: jest.fn().mockResolvedValue('signed.jwt.token'),
      verifyAsync: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('x'.repeat(48)),
            get: jest.fn().mockReturnValue(undefined),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('register', () => {
    const dto = {
      groupName: 'Acme',
      name: 'Ada',
      email: 'ada@acme.test',
      password: 'Str0ngPass!',
    };

    it('rejects a duplicate email with EMAIL_TAKEN', async () => {
      prisma.userEmailIndex.findUnique.mockResolvedValue({ email: dto.email, tenantId: 'existing', userId: 'u' });
      await expect(service.register(dto)).rejects.toThrow(ConflictException);
      expect(prisma.tenant.create).not.toHaveBeenCalled();
    });

    it('retries subdomain generation on a collision instead of failing', async () => {
      // First candidate ("acme") collides, second (suffixed) doesn't.
      prisma.tenant.findUnique.mockResolvedValueOnce({ id: 'existing', subdomain: 'acme' }).mockResolvedValueOnce(null);
      await service.register(dto);
      expect(prisma.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ subdomain: expect.stringMatching(/^acme-[0-9a-f]{6}$/) }),
        }),
      );
    });

    it('writes a matching userEmailIndex row inside the same transaction as the user', async () => {
      await service.register(dto);
      expect(tx.userEmailIndex.create).toHaveBeenCalledWith({
        data: { email: dto.email, tenantId: TENANT_ID, userId: USER_ID },
      });
    });

    it('creates tenant, all six system roles, owner user and role assignment', async () => {
      const result = await service.register(dto);

      expect(prisma.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ subdomain: 'acme', status: 'trial' }),
        }),
      );
      expect(tx.role.createMany).toHaveBeenCalledWith({
        data: SYSTEM_ROLE_NAMES.map((name) => ({ tenantId: TENANT_ID, name, isSystem: true })),
      });
      // owner assignment covers all branches (branchId null)
      expect(tx.userBranchRole.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ branchId: null }) }),
      );
      expect(tx.auditLog.create).toHaveBeenCalled();
      expect(result.verificationToken).toBe('signed.jwt.token');
      expect(result.tenantId).toBe(TENANT_ID);
    });

    it('hashes the password with bcrypt (never stores plaintext)', async () => {
      await service.register(dto);
      expect(bcrypt.hash).toHaveBeenCalledWith('Str0ngPass!', 12);
      expect(tx.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ passwordHash: 'hashed-password' }),
        }),
      );
    });
  });

  describe('login', () => {
    const dto = { email: 'ada@acme.test', password: 'pw' };
    const verifiedUser = {
      id: USER_ID,
      tenantId: TENANT_ID,
      email: dto.email,
      name: 'Ada',
      passwordHash: 'stored-hash',
      emailVerified: true,
      deletedAt: null,
    };

    beforeEach(() => {
      // The two-step lookup's first step — resolves which tenant to even
      // look in, since `users` returns zero rows with no app.tenant_id set
      // (FORCE ROW LEVEL SECURITY). Overridden per-test for the "email
      // never indexed at all" case below.
      prisma.userEmailIndex.findUnique.mockResolvedValue({ email: dto.email, tenantId: TENANT_ID, userId: USER_ID });
    });

    it('rejects an unknown email with INVALID_CREDENTIALS and still runs bcrypt', async () => {
      prisma.userEmailIndex.findUnique.mockResolvedValue(null);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
      expect(bcrypt.compare).toHaveBeenCalled(); // timing-safe: dummy hash comparison even on an index miss
      expect(prisma.withTenant).not.toHaveBeenCalled(); // never even resolved a tenant to look in
    });

    it('rejects a user missing from the resolved tenant with INVALID_CREDENTIALS', async () => {
      tx.user.findFirst.mockResolvedValue(null);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
      expect(bcrypt.compare).toHaveBeenCalled();
    });

    it('rejects a wrong password', async () => {
      tx.user.findFirst.mockResolvedValue(verifiedUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.login(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects unverified emails with EMAIL_NOT_VERIFIED', async () => {
      tx.user.findFirst.mockResolvedValue({ ...verifiedUser, emailVerified: false });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      await expect(service.login(dto)).rejects.toThrow(ForbiddenException);
    });

    it('returns a token pair and branch-scoped roles on success', async () => {
      tx.user.findFirst.mockResolvedValue(verifiedUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.login(dto);

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.refreshToken).toBe('signed.jwt.token');
      expect(result.user.roles).toEqual([{ branchId: null, role: 'owner' }]);
      // access token payload carries the fixed claim shape
      expect(jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'access' }),
        expect.any(Object),
      );
      expect(tx.user.update).toHaveBeenCalled(); // lastLoginAt
      expect(tx.auditLog.create).toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('rejects tokens whose tokenType is not refresh', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'access' });
      await expect(service.refresh('some.jwt')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects tampered/expired tokens', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));
      await expect(service.refresh('some.jwt')).rejects.toThrow(UnauthorizedException);
    });

    it('issues a fresh pair with roles reloaded from the DB', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'refresh' });
      tx.user.findFirst.mockResolvedValue({
        id: USER_ID,
        tenantId: TENANT_ID,
        email: 'a@b.c',
        name: 'Ada',
        deletedAt: null,
        emailVerified: true,
      });
      const result = await service.refresh('some.jwt');
      expect(result.user.roles).toEqual([{ branchId: null, role: 'owner' }]);
    });
  });

  describe('verifyEmail', () => {
    it('rejects garbage tokens with TOKEN_INVALID', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('invalid'));
      await expect(service.verifyEmail('nope')).rejects.toThrow(BadRequestException);
    });

    it('flips emailVerified exactly once (idempotent)', async () => {
      jwt.verifyAsync.mockResolvedValue({
        sub: USER_ID,
        tenantId: TENANT_ID,
        tokenType: 'email_verify',
      });
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, emailVerified: true });
      await service.verifyEmail('good.jwt');
      expect(tx.user.update).not.toHaveBeenCalled();
    });
  });

  describe('acceptInvite', () => {
    it('rejects malformed public tokens', async () => {
      await expect(service.acceptInvite('not-a-valid-token', { name: 'A', password: 'Pw1aaaaa' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects expired invites', async () => {
      tx.inviteToken.findUnique.mockResolvedValue({
        id: 'inv',
        acceptedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(
        service.acceptInvite(`${TENANT_ID}.${'a'.repeat(96)}`, { name: 'A', password: 'Pw1aaaaa' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects already-used invites', async () => {
      tx.inviteToken.findUnique.mockResolvedValue({
        id: 'inv',
        acceptedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
      });
      await expect(
        service.acceptInvite(`${TENANT_ID}.${'a'.repeat(96)}`, { name: 'A', password: 'Pw1aaaaa' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates the user (pre-verified), attaches the role and marks the invite used', async () => {
      tx.inviteToken.findUnique.mockResolvedValue({
        id: 'inv',
        email: 'staff@acme.test',
        roleId: 'role-fd',
        branchId: 'branch-1',
        acceptedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      tx.user.findFirst.mockResolvedValue(null);

      const result = await service.acceptInvite(`${TENANT_ID}.${'a'.repeat(96)}`, {
        name: 'Chidi',
        password: 'Pw1aaaaa',
      });

      expect(tx.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'staff@acme.test', emailVerified: true }),
        }),
      );
      expect(tx.userBranchRole.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ roleId: 'role-fd', branchId: 'branch-1' }),
        }),
      );
      expect(tx.inviteToken.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ acceptedAt: expect.any(Date) }) }),
      );
      expect(result.accessToken).toBe('signed.jwt.token');
    });

    it('rejects a duplicate email with EMAIL_TAKEN when it belongs to a different tenant', async () => {
      tx.inviteToken.findUnique.mockResolvedValue({
        id: 'inv',
        email: 'staff@acme.test',
        roleId: 'role-fd',
        branchId: 'branch-1',
        acceptedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      tx.user.findFirst.mockResolvedValue(null); // no existing user in *this* tenant
      tx.userEmailIndex.findUnique.mockResolvedValue({
        email: 'staff@acme.test',
        tenantId: 'some-other-tenant',
        userId: 'someone-else',
      });

      await expect(
        service.acceptInvite(`${TENANT_ID}.${'a'.repeat(96)}`, { name: 'Chidi', password: 'Pw1aaaaa' }),
      ).rejects.toThrow(ConflictException);
      expect(tx.user.create).not.toHaveBeenCalled();
    });
  });

  describe('listMyBranches', () => {
    it('returns [] without querying when there are no branch-scoped roles', async () => {
      const result = await service.listMyBranches(TENANT_ID, [{ branchId: null, role: 'owner' }]);
      expect(result).toEqual([]);
      expect(prisma.withTenant).not.toHaveBeenCalled();
    });

    it('dedupes repeated branchIds before querying', async () => {
      tx.branch = { findMany: jest.fn().mockResolvedValue([{ id: 'b1', name: 'Main' }]) };
      await service.listMyBranches(TENANT_ID, [
        { branchId: 'b1', role: 'front_desk' },
        { branchId: 'b1', role: 'housekeeper' },
        { branchId: 'b2', role: 'front_desk' },
      ]);
      expect(tx.branch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { in: ['b1', 'b2'] } }) }),
      );
    });

    it('filters out null branchIds before querying', async () => {
      tx.branch = { findMany: jest.fn().mockResolvedValue([]) };
      await service.listMyBranches(TENANT_ID, [
        { branchId: null, role: 'owner' },
        { branchId: 'b1', role: 'front_desk' },
      ]);
      expect(tx.branch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { in: ['b1'] } }) }),
      );
    });
  });
});
