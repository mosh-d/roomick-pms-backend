import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { AccountMailService } from '../../common/mail/account-mail.service';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';
import { HANDED_OVER_MINUTES, PasswordService, SELF_SERVICE_MINUTES } from './password.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('new-hash'),
  compare: jest.fn(),
}));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const SECRET = 'f'.repeat(64);
const TOKEN = `${TENANT_ID}.${SECRET}`;

const OWNER: JwtPayload = { sub: ACTOR_ID, tenantId: TENANT_ID, email: 'o@x.test', roles: [{ branchId: null, role: 'owner' }], tokenType: 'access' };
const MANAGER: JwtPayload = { sub: ACTOR_ID, tenantId: TENANT_ID, email: 'm@x.test', roles: [{ branchId: BRANCH_ID, role: 'manager' }], tokenType: 'access' };
const STAFF = { id: USER_ID, tenantId: TENANT_ID, email: 'sam@x.test', name: 'Sam', passwordHash: 'old-hash', deletedAt: null };

function makeTx() {
  return {
    user: { findFirst: jest.fn().mockResolvedValue(STAFF), update: jest.fn().mockImplementation(({ data }: { data: object }) => Promise.resolve({ ...STAFF, ...data })) },
    userBranchRole: { findMany: jest.fn().mockResolvedValue([{ branchId: BRANCH_ID, role: { name: 'front_desk' } }]) },
    passwordResetToken: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('PasswordService', () => {
  let service: PasswordService;
  let tx: ReturnType<typeof makeTx>;
  let prisma: { userEmailIndex: { findUnique: jest.Mock }; withTenant: jest.Mock };
  let mail: { delivers: boolean; passwordReset: jest.Mock };
  let auth: { startSession: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    tx = makeTx();
    prisma = {
      userEmailIndex: { findUnique: jest.fn().mockResolvedValue({ email: STAFF.email, tenantId: TENANT_ID, userId: USER_ID }) },
      withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)),
    };
    mail = { delivers: true, passwordReset: jest.fn().mockResolvedValue(true) };
    auth = { startSession: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r', user: {} }) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        PasswordService,
        { provide: PrismaService, useValue: prisma },
        { provide: AccountMailService, useValue: mail },
        { provide: AuthService, useValue: auth },
      ],
    }).compile();
    service = moduleRef.get(PasswordService);
  });

  describe('forgot your password', () => {
    it('says so when there is no email to send a link with — and looks nothing up', () => {
      mail.delivers = false;
      expect(service.forgot('sam@x.test')).toEqual({ emailEnabled: false });
      expect(prisma.userEmailIndex.findUnique).not.toHaveBeenCalled();
    });

    it('answers straight away, the same for any address', () => {
      prisma.userEmailIndex.findUnique.mockReturnValue(new Promise(() => undefined)); // never settles
      expect(service.forgot('sam@x.test')).toEqual({ emailEnabled: true });
    });

    it('emails a one-hour link, storing only a hash of it', async () => {
      await service.sendResetLink('sam@x.test');
      const link = mail.passwordReset.mock.calls[0][2] as string;
      expect(mail.passwordReset).toHaveBeenCalledWith('sam@x.test', 'Sam', expect.stringContaining('/reset-password?token='), SELF_SERVICE_MINUTES);
      const token = decodeURIComponent(link.split('token=')[1]);
      const secret = token.split('.')[1];
      const stored = tx.passwordResetToken.create.mock.calls[0][0] as { data: { tokenHash: string; createdBy: string | null; expiresAt: Date } };
      expect(stored.data.tokenHash).toBe(createHash('sha256').update(secret).digest('hex'));
      expect(stored.data.createdBy).toBeNull();
      expect(stored.data.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(SELF_SERVICE_MINUTES * 60_000);
      // Any older link for them stops working.
      expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith({ where: { userId: USER_ID, usedAt: null }, data: { usedAt: expect.any(Date) } });
    });

    it('sends nothing for an unknown address, or a second email within the minute', async () => {
      prisma.userEmailIndex.findUnique.mockResolvedValue(null);
      await service.sendResetLink('nobody@x.test');
      prisma.userEmailIndex.findUnique.mockResolvedValue({ email: STAFF.email, tenantId: TENANT_ID, userId: USER_ID });
      tx.passwordResetToken.findFirst.mockResolvedValue({ id: 'recent' });
      await service.sendResetLink('sam@x.test');
      expect(mail.passwordReset).not.toHaveBeenCalled();
      expect(tx.passwordResetToken.create).not.toHaveBeenCalled();
    });
  });

  describe('using a link', () => {
    const row = { id: 'prt', userId: USER_ID, usedAt: null, createdBy: null, expiresAt: new Date(Date.now() + 60_000) };

    it('refuses a malformed, unknown, used or expired link', async () => {
      await expect(service.reset('garbage', 'N3wPassword')).rejects.toThrow(BadRequestException);
      tx.passwordResetToken.findUnique.mockResolvedValue(null);
      await expect(service.reset(TOKEN, 'N3wPassword')).rejects.toThrow(BadRequestException);
      tx.passwordResetToken.findUnique.mockResolvedValue({ ...row, usedAt: new Date() });
      await expect(service.reset(TOKEN, 'N3wPassword')).rejects.toThrow(BadRequestException);
      tx.passwordResetToken.findUnique.mockResolvedValue({ ...row, expiresAt: new Date(Date.now() - 1) });
      await expect(service.reset(TOKEN, 'N3wPassword')).rejects.toThrow(BadRequestException);
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('looks the link up by the hash of its secret', async () => {
      tx.passwordResetToken.findUnique.mockResolvedValue(row);
      await service.reset(TOKEN, 'N3wPassword');
      expect(tx.passwordResetToken.findUnique).toHaveBeenCalledWith({ where: { tokenHash: createHash('sha256').update(SECRET).digest('hex') } });
    });

    it('sets the new password and ends every session — and an emailed link proves the address', async () => {
      tx.passwordResetToken.findUnique.mockResolvedValue(row);
      await expect(service.reset(TOKEN, 'N3wPassword')).resolves.toEqual({ reset: true });
      expect(bcrypt.hash).toHaveBeenCalledWith('N3wPassword', 12);
      expect(tx.user.update).toHaveBeenCalledWith({ where: { id: USER_ID }, data: { passwordHash: 'new-hash', emailVerified: true } });
      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: USER_ID, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    });

    it('a link a manager handed over changes the password but proves nothing about the address', async () => {
      tx.passwordResetToken.findUnique.mockResolvedValue({ ...row, createdBy: ACTOR_ID });
      await service.reset(TOKEN, 'N3wPassword');
      expect(tx.user.update).toHaveBeenCalledWith({ where: { id: USER_ID }, data: { passwordHash: 'new-hash' } });
    });

    it('lets only one of two tabs racing with the same link use it', async () => {
      tx.passwordResetToken.findUnique.mockResolvedValue(row);
      tx.passwordResetToken.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.reset(TOKEN, 'N3wPassword')).rejects.toThrow(BadRequestException);
      expect(tx.user.update).not.toHaveBeenCalled();
    });
  });

  describe('a link for a colleague', () => {
    it('is made for staff below the one asking, emailed, and returned to hand over', async () => {
      const result = await service.createLink(MANAGER, USER_ID);
      expect(result.emailed).toBe(true);
      expect(result.link).toContain('/reset-password?token=');
      expect(mail.passwordReset).toHaveBeenCalledWith('sam@x.test', 'Sam', result.link, HANDED_OVER_MINUTES);
      expect((tx.passwordResetToken.create.mock.calls[0][0] as { data: { createdBy: string } }).data.createdBy).toBe(ACTOR_ID);
    });

    it('is never made for yourself, the owner, or — by a manager — another manager', async () => {
      await expect(service.createLink(OWNER, ACTOR_ID)).rejects.toThrow(ForbiddenException);
      tx.userBranchRole.findMany.mockResolvedValue([{ branchId: null, role: { name: 'owner' } }]);
      await expect(service.createLink(OWNER, USER_ID)).rejects.toThrow(ForbiddenException);
      tx.userBranchRole.findMany.mockResolvedValue([{ branchId: BRANCH_ID, role: { name: 'manager' } }]);
      await expect(service.createLink(MANAGER, USER_ID)).rejects.toThrow(ForbiddenException);
      await expect(service.createLink(OWNER, USER_ID)).resolves.toBeDefined();
    });
  });

  describe('changing your own password', () => {
    it('needs the current password — a 400, so the app doesn’t go renewing a fine session', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.changePassword(OWNER, 'wrong', 'N3wPassword')).rejects.toThrow(BadRequestException);
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('wants a different one', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      await expect(service.changePassword(OWNER, 'Old1pass', 'Old1pass')).rejects.toThrow(/different/);
    });

    it('ends every session and carries on in a fresh one', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      tx.user.findFirst.mockResolvedValue({ ...STAFF, id: ACTOR_ID });
      const result = await service.changePassword(OWNER, 'Old1pass', 'N3wPassword');
      expect(tx.user.findFirst).toHaveBeenCalledWith({ where: { id: ACTOR_ID, deletedAt: null } });
      expect(tx.user.update).toHaveBeenCalledWith({ where: { id: ACTOR_ID }, data: { passwordHash: 'new-hash' } });
      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({ where: { userId: ACTOR_ID, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
      expect(auth.startSession).toHaveBeenCalled();
      expect(result.accessToken).toBe('a');
    });
  });
});
