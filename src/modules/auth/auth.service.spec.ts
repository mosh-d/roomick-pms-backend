import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { AccountMailService } from '../../common/mail/account-mail.service';
import { PermissionsService } from '../../common/permissions/permissions.service';
import { RoutePermissionMapService } from '../../common/permissions/route-permission-map.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService, LoginResult, SYSTEM_ROLE_NAMES } from './auth.service';
import { MfaService } from './mfa.service';

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
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'role-new', ...data })),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'role-custom', name: 'Night Auditor', isSystem: false, ...data })),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    user: {
      create: jest.fn().mockResolvedValue({ id: USER_ID, tenantId: TENANT_ID, email: 'a@b.c', name: 'A' }),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    userBranchRole: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([{ branchId: null, role: { name: 'owner' } }]),
    },
    inviteToken: {
      count: jest.fn().mockResolvedValue(0),
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
    refreshToken: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock; decode: jest.Mock };
  let permissions: { invalidate: jest.Mock; rolesFor: jest.Mock };
  let mfa: { checkSecondFactor: jest.Mock; failureFor: jest.Mock };
  let accountMail: { delivers: boolean; verifyEmail: jest.Mock };

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
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 7 * 86_400 }),
    };
    permissions = { invalidate: jest.fn(), rolesFor: jest.fn().mockResolvedValue(new Map()) };
    mfa = { checkSecondFactor: jest.fn(), failureFor: jest.fn().mockImplementation(() => new UnauthorizedException({ code: 'MFA_INVALID_CODE' })) };
    // No email provider unless a test sets one up.
    accountMail = { delivers: false, verifyEmail: jest.fn().mockResolvedValue(false) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        { provide: PermissionsService, useValue: permissions },
        { provide: MfaService, useValue: mfa },
        { provide: AccountMailService, useValue: accountMail },
        { provide: RoutePermissionMapService, useValue: { systemRolePresets: () => ({ front_desk: { reservations: ['create', 'read', 'update'] } }) } },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => (key === 'JWT_REFRESH_SECRET' ? 'refresh-secret' : 'x'.repeat(48))),
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
      // No email provider: the sign-up page gets the token, as in development all along.
      expect(result.verificationToken).toBe('signed.jwt.token');
      expect(result.emailed).toBe(false);
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

  describe('email confirmation by email', () => {
    const registerDto = { email: 'owner@acme.test', password: 'Pw1aaaaa', name: 'Ada', groupName: 'Acme Hotels', country: 'NG' };

    it('once a provider is set up, emails the link and never returns the token', async () => {
      accountMail.delivers = true;
      accountMail.verifyEmail.mockResolvedValue(true);
      const result = await service.register(registerDto);
      expect(result.verificationToken).toBeNull();
      expect(result.emailed).toBe(true);
      expect(accountMail.verifyEmail).toHaveBeenCalledWith('owner@acme.test', 'Ada', expect.stringContaining('/verify-email?token=signed.jwt.token'));
    });

    it('sends the link again in the background, answering the same for any address', async () => {
      accountMail.delivers = true;
      await expect(service.resendVerification('nobody@acme.test')).resolves.toEqual({ emailEnabled: true, verificationToken: null });

      prisma.userEmailIndex.findUnique.mockResolvedValue({ email: 'owner@acme.test', tenantId: TENANT_ID, userId: USER_ID });
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, tenantId: TENANT_ID, email: 'owner@acme.test', name: 'Ada', emailVerified: false, passwordHash: 'h' });
      await service.emailVerificationLink('owner@acme.test');
      expect(accountMail.verifyEmail).toHaveBeenCalledWith('owner@acme.test', 'Ada', expect.stringContaining('/verify-email?token='));
    });

    it('sends nothing to an address that is already confirmed', async () => {
      prisma.userEmailIndex.findUnique.mockResolvedValue({ email: 'owner@acme.test', tenantId: TENANT_ID, userId: USER_ID });
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, tenantId: TENANT_ID, email: 'owner@acme.test', name: 'Ada', emailVerified: true });
      await service.emailVerificationLink('owner@acme.test');
      expect(accountMail.verifyEmail).not.toHaveBeenCalled();
    });

    it('without email, gives the token back only for the account’s own password', async () => {
      prisma.userEmailIndex.findUnique.mockResolvedValue({ email: 'owner@acme.test', tenantId: TENANT_ID, userId: USER_ID });
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, tenantId: TENANT_ID, email: 'owner@acme.test', name: 'Ada', emailVerified: false, passwordHash: 'h' });

      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.resendVerification('owner@acme.test', 'wrong')).resolves.toEqual({ emailEnabled: false, verificationToken: null });
      await expect(service.resendVerification('owner@acme.test')).resolves.toEqual({ emailEnabled: false, verificationToken: null });

      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      await expect(service.resendVerification('owner@acme.test', 'Pw1aaaaa')).resolves.toEqual({ emailEnabled: false, verificationToken: 'signed.jwt.token' });
      expect(accountMail.verifyEmail).not.toHaveBeenCalled();
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

      const result = (await service.login(dto)) as LoginResult;

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

    it('records the session — the refresh token as a hash, never itself, expiring with the token', async () => {
      tx.user.findFirst.mockResolvedValue(verifiedUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      await service.login(dto);
      const data = (tx.refreshToken.create.mock.calls[0] as [{ data: { tokenHash: string; expiresAt: Date; userId: string } }])[0].data;
      expect(data.userId).toBe(USER_ID);
      expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.tokenHash).not.toContain('signed');
      expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
      // each refresh token carries its own id, so two sign-ins in one second never collide
      expect(jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({ tokenType: 'refresh', jti: expect.any(String) }), expect.any(Object));
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

    const liveSession = () => ({ id: 'session-1', userId: USER_ID, revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) });

    it('issues a fresh pair with roles reloaded from the DB, retiring the token it was given', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'refresh' });
      tx.refreshToken.findUnique.mockResolvedValue(liveSession());
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
      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({ where: { id: 'session-1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
      expect(tx.refreshToken.create).toHaveBeenCalledTimes(1); // its replacement
    });

    it('refuses a token with no session behind it — signed out, or issued before sessions were stored', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'refresh' });
      tx.refreshToken.findUnique.mockResolvedValue(null);
      await expect(service.refresh('some.jwt')).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a token already used once, or one whose session expired', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'refresh' });
      tx.refreshToken.findUnique.mockResolvedValueOnce({ ...liveSession(), revokedAt: new Date() });
      await expect(service.refresh('some.jwt')).rejects.toThrow(UnauthorizedException);
      tx.refreshToken.findUnique.mockResolvedValueOnce({ ...liveSession(), expiresAt: new Date(Date.now() - 1000) });
      await expect(service.refresh('some.jwt')).rejects.toThrow(UnauthorizedException);
    });

    it('lets only one of two racing renewals through', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'refresh' });
      tx.refreshToken.findUnique.mockResolvedValue(liveSession());
      tx.refreshToken.updateMany.mockResolvedValue({ count: 0 }); // the other request retired it first
      await expect(service.refresh('some.jwt')).rejects.toThrow(UnauthorizedException);
      expect(tx.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('ends the session on the server and audits it', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'refresh' });
      await service.logout('some.jwt');
      expect(jwt.verifyAsync).toHaveBeenCalledWith('some.jwt', expect.objectContaining({ ignoreExpiration: true }));
      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({ where: { tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), revokedAt: null }, data: { revokedAt: expect.any(Date) } });
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'auth.logout' }) }));
    });

    it('is silent about a token that is garbage or not a refresh token', async () => {
      jwt.verifyAsync.mockRejectedValueOnce(new Error('invalid'));
      await expect(service.logout('nope')).resolves.toBeUndefined();
      jwt.verifyAsync.mockResolvedValueOnce({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'access' });
      await expect(service.logout('access.jwt')).resolves.toBeUndefined();
      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
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
      expect((result as LoginResult).accessToken).toBe('signed.jwt.token');
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

  describe('invitations to someone who already has an account here', () => {
    const TOKEN = `${TENANT_ID}.${'a'.repeat(96)}`;
    const invite = { id: 'inv', email: 'owner@acme.test', roleId: 'role-fd', branchId: 'branch-1', acceptedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    const existing = { id: USER_ID, tenantId: TENANT_ID, email: 'owner@acme.test', name: 'Ada', passwordHash: 'their-hash', deletedAt: null, emailVerified: true };

    beforeEach(() => {
      tx.inviteToken.findUnique.mockResolvedValue(invite);
      tx.user.findFirst.mockResolvedValue(existing);
    });

    it('never signs anyone in with a password that isn’t the account’s own', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.acceptInvite(TOKEN, { password: 'Anything1' })).rejects.toThrow(UnauthorizedException);
      expect(bcrypt.compare).toHaveBeenCalledWith('Anything1', 'their-hash');
      expect(tx.userBranchRole.create).not.toHaveBeenCalled();
      expect(tx.inviteToken.update).not.toHaveBeenCalled();
      expect(tx.refreshToken.create).not.toHaveBeenCalled();
    });

    it('with the right password, adds the role and sends them to sign in as usual — no session handed out', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      const result = await service.acceptInvite(TOKEN, { password: 'Pw1aaaaa' });
      expect(result).toEqual({ joined: true, email: 'owner@acme.test' });
      expect(tx.userBranchRole.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: USER_ID, roleId: 'role-fd', branchId: 'branch-1' }) }));
      expect(tx.inviteToken.update).toHaveBeenCalled();
      expect(tx.refreshToken.create).not.toHaveBeenCalled();
      expect(tx.user.create).not.toHaveBeenCalled();
    });

    it('refuses a deactivated account', async () => {
      tx.user.findFirst.mockResolvedValue({ ...existing, deletedAt: new Date() });
      await expect(service.acceptInvite(TOKEN, { password: 'Pw1aaaaa' })).rejects.toThrow(ConflictException);
      expect(tx.userBranchRole.create).not.toHaveBeenCalled();
    });

    it('asks someone new for their name and a strong password', async () => {
      tx.user.findFirst.mockResolvedValue(null);
      await expect(service.acceptInvite(TOKEN, { password: 'Pw1aaaaa' })).rejects.toThrow(BadRequestException);
      await expect(service.acceptInvite(TOKEN, { name: 'Chidi', password: 'weakpass' })).rejects.toThrow(BadRequestException);
      expect(tx.user.create).not.toHaveBeenCalled();
    });

    it('previews who, where and as what — and whether they already have an account', async () => {
      tx.inviteToken.findUnique.mockResolvedValue({ ...invite, role: { name: 'front_desk' }, branch: { name: 'Lekki' }, tenant: { groupName: 'Acme Hotels' } });
      tx.user.findFirst.mockResolvedValue({ deletedAt: null });
      await expect(service.previewInvite(TOKEN)).resolves.toEqual({
        email: 'owner@acme.test',
        organisation: 'Acme Hotels',
        branch: 'Lekki',
        role: 'front_desk',
        expiresAt: invite.expiresAt,
        existingAccount: true,
      });
      tx.user.findFirst.mockResolvedValue(null);
      await expect(service.previewInvite(TOKEN)).resolves.toMatchObject({ existingAccount: false });
    });

    it('previews nothing for a used or expired invitation', async () => {
      tx.inviteToken.findUnique.mockResolvedValue({ ...invite, acceptedAt: new Date(), role: { name: 'front_desk' }, branch: null, tenant: { groupName: 'Acme' } });
      await expect(service.previewInvite(TOKEN)).rejects.toThrow(BadRequestException);
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

  describe('custom roles', () => {
    const CUSTOM = { id: 'role-custom', name: 'Night Auditor', isSystem: false, permissions: { reservations: ['read'] } };
    const SEEDED = { id: 'role-manager', name: 'manager', isSystem: true, permissions: null };

    it('creates one with a scoped permission map, and clears the cached one', async () => {
      tx.role.findFirst.mockResolvedValue(null);
      const role = await service.createRole(TENANT_ID, '  Night   Auditor ', { reservations: ['read', 'read'] }, USER_ID);
      const data = (tx.role.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({ name: 'Night Auditor', isSystem: false, permissions: { reservations: ['read'] } });
      expect(role.name).toBe('Night Auditor');
      expect(permissions.invalidate).toHaveBeenCalledWith(TENANT_ID);
      expect(tx.auditLog.create).toHaveBeenCalled();
    });

    it('refuses a name that is one of the built-in roles, or a duplicate', async () => {
      tx.role.findFirst.mockResolvedValue(null);
      await expect(service.createRole(TENANT_ID, 'Front Desk', {}, USER_ID)).rejects.toThrow(/built-in roles/);
      await expect(service.createRole(TENANT_ID, 'X', {}, USER_ID)).rejects.toThrow(/2 to 60 characters/);
      tx.role.findFirst.mockResolvedValue(CUSTOM);
      await expect(service.createRole(TENANT_ID, 'Night Auditor', {}, USER_ID)).rejects.toThrow(/already exists/);
    });

    it('refuses a permission for something that can’t be delegated', async () => {
      tx.role.findFirst.mockResolvedValue(null);
      await expect(service.createRole(TENANT_ID, 'Sneaky', { staff: ['create'] }, USER_ID)).rejects.toThrow(/isn’t something a role can be given/);
      expect(tx.role.create).not.toHaveBeenCalled();
    });

    it('won’t re-scope a built-in role — its access is what the routes say', async () => {
      tx.role.findFirst.mockResolvedValue(SEEDED);
      await expect(service.updateRolePermissions(TENANT_ID, 'role-manager', { reservations: ['delete'] }, USER_ID)).rejects.toThrow(/built-in role/);
      expect(tx.role.update).not.toHaveBeenCalled();
    });

    it('won’t delete one somebody still holds', async () => {
      tx.role.findFirst.mockResolvedValue(CUSTOM);
      tx.userBranchRole.count.mockResolvedValue(2);
      await expect(service.deleteRole(TENANT_ID, 'role-custom', USER_ID)).rejects.toThrow(/still held by 2 staff members/);
      tx.userBranchRole.count.mockResolvedValue(0);
      tx.inviteToken.count.mockResolvedValue(1);
      await expect(service.deleteRole(TENANT_ID, 'role-custom', USER_ID)).rejects.toThrow(/1 unaccepted invite/);
      expect(tx.role.delete).not.toHaveBeenCalled();
    });

    it('deletes one nobody holds, and clears the cache', async () => {
      tx.role.findFirst.mockResolvedValue(CUSTOM);
      tx.userBranchRole.count.mockResolvedValue(0);
      tx.inviteToken.count.mockResolvedValue(0);
      await expect(service.deleteRole(TENANT_ID, 'role-custom', USER_ID)).resolves.toEqual({ deleted: true });
      expect(permissions.invalidate).toHaveBeenCalledWith(TENANT_ID);
    });

    it('publishes the vocabulary a matrix is built from, and what each built-in role really covers', () => {
      const catalogue = service.permissionCatalogue();
      expect(catalogue.actions).toEqual(['read', 'create', 'update', 'delete']);
      expect(catalogue.modules.some((module) => module.key === 'reservations')).toBe(true);
      expect(catalogue.systemRolePresets.front_desk).toEqual({ reservations: ['create', 'read', 'update'] });
      expect(catalogue.undelegatable.length).toBeGreaterThan(0);
    });
  });

  describe('two-step sign-in', () => {
    const dto = { email: 'owner@example.com', password: 'Str0ngPass!1' };

    it('stops a correct password at a challenge — no tokens — when MFA is on', async () => {
      prisma.userEmailIndex.findUnique.mockResolvedValue({ email: dto.email, tenantId: TENANT_ID });
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, tenantId: TENANT_ID, email: dto.email, emailVerified: true, passwordHash: 'h', mfaEnabledAt: new Date() });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      jwt.signAsync.mockResolvedValue('challenge.jwt');

      const result = await service.login(dto);

      expect(result).toEqual({ mfaRequired: true, challengeToken: 'challenge.jwt', expiresInSeconds: 300 });
      expect(jwt.signAsync).toHaveBeenCalledTimes(1);
      const [payload, options] = jwt.signAsync.mock.calls[0] as [Record<string, unknown>, { secret: string }];
      expect(payload).toEqual({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'mfa_challenge' });
      // Signed with the refresh secret, so it can never verify as an access token.
      expect(options.secret).toBe('refresh-secret');
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('refuses a ticket of any other type', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'refresh' });
      await expect(service.verifyMfaLogin('t', '123456')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mfa.checkSecondFactor).not.toHaveBeenCalled();
    });

    it('turns a wrong code into the MFA error, issuing nothing', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'mfa_challenge' });
      mfa.checkSecondFactor.mockResolvedValue({ ok: false, lockedUntil: null, attemptsLeft: 4 });
      await expect(service.verifyMfaLogin('t', '000000')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('issues the session after a right code, and says how it was passed', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, tokenType: 'mfa_challenge' });
      mfa.checkSecondFactor.mockResolvedValue({ ok: true, method: 'recovery', recoveryCodesLeft: 3 });
      tx.user.findFirst.mockResolvedValue({ id: USER_ID, tenantId: TENANT_ID, email: 'a@b.c', name: 'A', emailVerified: true, mfaEnabledAt: new Date() });
      const result = await service.verifyMfaLogin('t', 'abcde-fghjk');
      expect(result).toMatchObject({ accessToken: 'signed.jwt.token', secondFactor: 'recovery', recoveryCodesLeft: 3 });
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'auth.login' }) }));
    });
  });
});
