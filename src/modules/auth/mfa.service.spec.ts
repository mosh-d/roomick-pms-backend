import { BadRequestException, ConflictException, ForbiddenException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { MFA_LOCK_MINUTES, MFA_MAX_FAILED_ATTEMPTS, MfaService } from './mfa.service';
import { base32Decode, hashRecoveryCode, hotp, stepAt } from './totp';

jest.mock('bcrypt', () => ({ compare: jest.fn() }));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const codeNow = (offsetSteps = 0) => hotp(base32Decode(SECRET), stepAt(Date.now()) + offsetSteps);

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    tenantId: TENANT_ID,
    email: 'gm@lekki.example',
    passwordHash: 'hash',
    deletedAt: null,
    mfaSecret: `enc:${SECRET}`,
    mfaEnabledAt: new Date('2026-09-01'),
    mfaLastUsedStep: null,
    mfaFailedAttempts: 0,
    mfaLockedUntil: null,
    mfaRecoveryCodes: [hashRecoveryCode('abcde-fghjk'), hashRecoveryCode('mnpqr-stuvw')],
    ...overrides,
  };
}

function actor(role: string, sub = OTHER_ID): JwtPayload {
  return { sub, tenantId: TENANT_ID, email: 'owner@lekki.example', roles: [{ branchId: null, role }], tokenType: 'access' };
}

describe('MfaService', () => {
  let service: MfaService;
  let tx: {
    user: { findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    auditLog: { create: jest.Mock };
    $executeRaw: jest.Mock;
  };

  beforeEach(async () => {
    tx = {
      user: {
        findFirst: jest.fn().mockResolvedValue(user()),
        update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(user(data))),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MfaService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: EncryptionService, useValue: { encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, '') } },
      ],
    }).compile();
    service = moduleRef.get(MfaService);
  });

  describe('setup', () => {
    it('stores a new secret encrypted, and returns it once with the app link', async () => {
      tx.user.findFirst.mockResolvedValue(user({ mfaEnabledAt: null, mfaSecret: null }));
      const result = await service.beginSetup(TENANT_ID, USER_ID);
      expect(result.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(result.otpauthUri).toContain(`secret=${result.secret}`);
      expect((tx.user.update.mock.calls[0][0] as { data: { mfaSecret: string } }).data.mfaSecret).toBe(`enc:${result.secret}`);
    });

    it('won’t start over while it’s on', async () => {
      await expect(service.beginSetup(TENANT_ID, USER_ID)).rejects.toBeInstanceOf(ConflictException);
    });

    it('switches on only with a right first code, and hands back ten recovery codes stored as hashes', async () => {
      tx.user.findFirst.mockResolvedValue(user({ mfaEnabledAt: null }));
      await expect(service.enable(TENANT_ID, USER_ID, '000000')).rejects.toBeInstanceOf(UnauthorizedException);
      const result = await service.enable(TENANT_ID, USER_ID, codeNow());
      expect(result.recoveryCodes).toHaveLength(10);
      const data = (tx.user.update.mock.calls[0][0] as { data: { mfaEnabledAt: Date; mfaRecoveryCodes: string[] } }).data;
      expect(data.mfaEnabledAt).toBeInstanceOf(Date);
      expect(data.mfaRecoveryCodes).toEqual(result.recoveryCodes.map(hashRecoveryCode));
      expect(result.status).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    });

    it('needs setup started before a code can switch it on', async () => {
      tx.user.findFirst.mockResolvedValue(user({ mfaEnabledAt: null, mfaSecret: null }));
      await expect(service.enable(TENANT_ID, USER_ID, codeNow())).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('checkSecondFactor', () => {
    it('accepts a current code and records its step so it can’t be used again', async () => {
      const result = await service.checkSecondFactor(TENANT_ID, USER_ID, codeNow());
      expect(result).toMatchObject({ ok: true, method: 'totp' });
      const where = (tx.user.updateMany.mock.calls[0][0] as { where: { OR: unknown[] } }).where;
      expect(where.OR).toEqual([{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: stepAt(Date.now()) } }]);
    });

    it('refuses a code whose step was already used', async () => {
      tx.user.findFirst.mockResolvedValue(user({ mfaLastUsedStep: stepAt(Date.now()) + 1 }));
      const result = await service.checkSecondFactor(TENANT_ID, USER_ID, codeNow());
      expect(result.ok).toBe(false);
    });

    it('treats losing a race for the same code as a failure', async () => {
      tx.user.updateMany.mockResolvedValue({ count: 0 });
      expect((await service.checkSecondFactor(TENANT_ID, USER_ID, codeNow())).ok).toBe(false);
    });

    it('spends a recovery code atomically, however it is typed', async () => {
      const result = await service.checkSecondFactor(TENANT_ID, USER_ID, ' ABCDE FGHJK ');
      expect(result).toEqual({ ok: true, method: 'recovery', recoveryCodesLeft: 1 });
      expect(tx.$executeRaw).toHaveBeenCalled();
    });

    it('refuses a recovery code that was already spent', async () => {
      tx.$executeRaw.mockResolvedValue(0);
      expect((await service.checkSecondFactor(TENANT_ID, USER_ID, 'abcde-fghjk')).ok).toBe(false);
    });

    it('counts wrong codes and, at the limit, pauses the second step', async () => {
      tx.user.findFirst.mockResolvedValue(user({ mfaFailedAttempts: 2 }));
      const third = await service.checkSecondFactor(TENANT_ID, USER_ID, '000000');
      expect(third).toEqual({ ok: false, lockedUntil: null, attemptsLeft: MFA_MAX_FAILED_ATTEMPTS - 3 });
      expect((tx.user.update.mock.calls[0][0] as { data: Record<string, unknown> }).data).toEqual({ mfaFailedAttempts: 3 });

      tx.user.update.mockClear();
      tx.user.findFirst.mockResolvedValue(user({ mfaFailedAttempts: MFA_MAX_FAILED_ATTEMPTS - 1 }));
      const last = await service.checkSecondFactor(TENANT_ID, USER_ID, '000000');
      expect(last.ok).toBe(false);
      const locked = (last as { lockedUntil: Date }).lockedUntil;
      expect(locked.getTime() - Date.now()).toBeGreaterThan((MFA_LOCK_MINUTES - 1) * 60_000);
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'auth.mfa_locked' }) }));
    });

    it('refuses even a right code while paused', async () => {
      tx.user.findFirst.mockResolvedValue(user({ mfaLockedUntil: new Date(Date.now() + 60_000) }));
      const result = await service.checkSecondFactor(TENANT_ID, USER_ID, codeNow());
      expect(result.ok).toBe(false);
      expect(tx.user.updateMany).not.toHaveBeenCalled();
      const error = service.failureFor(result as { ok: false; lockedUntil: Date; attemptsLeft: number });
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });
  });

  describe('turning it off and resetting', () => {
    it('needs the password as well as a code', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.disable(TENANT_ID, USER_ID, 'wrong', codeNow())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tx.user.update).not.toHaveBeenCalled();

      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      const status = await service.disable(TENANT_ID, USER_ID, 'right', codeNow());
      expect(status.enabled).toBe(false);
      expect((tx.user.update.mock.calls.at(-1)![0] as { data: Record<string, unknown> }).data).toMatchObject({ mfaSecret: null, mfaEnabledAt: null, mfaRecoveryCodes: [] });
    });

    it('lets an owner reset a colleague, never themselves, and nobody else reset anyone', async () => {
      await expect(service.resetForUser(TENANT_ID, actor('manager'), USER_ID)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.resetForUser(TENANT_ID, actor('owner', USER_ID), USER_ID)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.resetForUser(TENANT_ID, actor('owner'), USER_ID)).resolves.toEqual({ reset: true });
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'auth.mfa_reset', entityId: USER_ID }) }));
    });
  });
});
