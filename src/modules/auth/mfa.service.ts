import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { SystemRole } from '../../common/decorators/roles.decorator';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import {
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from './totp';

/** Five wrong codes in a row pause the second step for fifteen minutes. */
export const MFA_MAX_FAILED_ATTEMPTS = 5;
export const MFA_LOCK_MINUTES = 15;
const ISSUER = 'Roomick';

export interface MfaStatus {
  enabled: boolean;
  enabledAt: Date | null;
  /** Setup has been started but not confirmed with a first code. */
  pendingSetup: boolean;
  recoveryCodesLeft: number;
}

export type SecondFactorResult =
  | { ok: true; method: 'totp' | 'recovery'; recoveryCodesLeft: number }
  | { ok: false; lockedUntil: Date | null; attemptsLeft: number };

/**
 * Two-step sign-in for staff: an authenticator app's six-digit code after the
 * password (RFC 6238, see `totp.ts`).
 *
 * The secret is encrypted at rest with the same AES-256-GCM key as guest ID
 * documents, and is shown to the user exactly once, at setup. Setup is two
 * steps on purpose — the secret is stored when setup starts but only takes
 * effect once a first code proves the app has it, so closing the tab halfway
 * never locks anybody out.
 *
 * Every check of a code goes through `checkSecondFactor`, which commits its
 * own bookkeeping (failed attempts, the lock, the last step used, a spent
 * recovery code) before the caller decides what to do — a wrong code thrown
 * inside the same transaction would roll its own failure count back.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async status(tenantId: string, userId: string): Promise<MfaStatus> {
    const user = await this.prisma.withTenant(tenantId, (tx) => this.loadUser(tx, userId));
    return this.toStatus(user);
  }

  /** A new secret every time setup starts; restarting setup simply replaces the unconfirmed one. */
  async beginSetup(tenantId: string, userId: string): Promise<{ secret: string; otpauthUri: string }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const user = await this.loadUser(tx, userId);
      if (user.mfaEnabledAt) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'Two-step sign-in is already on. Turn it off first to set up a new device.' });
      }
      const secret = generateSecret();
      await tx.user.update({ where: { id: userId }, data: { mfaSecret: this.encryption.encrypt(secret), mfaLastUsedStep: null, mfaFailedAttempts: 0, mfaLockedUntil: null } });
      return { secret, otpauthUri: otpauthUri(ISSUER, user.email, secret) };
    });
  }

  /** The first valid code switches it on and returns recovery codes — the only time they are ever shown. */
  async enable(tenantId: string, userId: string, code: string): Promise<{ recoveryCodes: string[]; status: MfaStatus }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const user = await this.loadUser(tx, userId);
      if (user.mfaEnabledAt) throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'Two-step sign-in is already on' });
      if (!user.mfaSecret) throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Start setup first, then enter the code your app shows' });

      const step = verifyTotp(this.encryption.decrypt(user.mfaSecret), code, Date.now(), null);
      if (step === null) {
        throw new UnauthorizedException({
          code: ErrorCode.MFA_INVALID_CODE,
          message: 'That code doesn’t match. Check the time on your phone is set automatically, then try the newest code.',
        });
      }

      const recoveryCodes = generateRecoveryCodes();
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          mfaEnabledAt: new Date(),
          mfaLastUsedStep: step,
          mfaFailedAttempts: 0,
          mfaLockedUntil: null,
          mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode),
        },
      });
      await this.audit(tx, tenantId, userId, 'auth.mfa_enabled', userId, null);
      return { recoveryCodes, status: this.toStatus(updated) };
    });
  }

  /**
   * Turning it off needs both the password and a current code (or a recovery
   * code): a session left open on a shared front-desk computer must not be
   * enough to strip the second factor off an account.
   */
  async disable(tenantId: string, userId: string, password: string, code: string): Promise<MfaStatus> {
    await this.assertPassword(tenantId, userId, password);
    await this.requireSecondFactor(tenantId, userId, code);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const updated = await tx.user.update({ where: { id: userId }, data: this.clearedMfa() });
      await this.audit(tx, tenantId, userId, 'auth.mfa_disabled', userId, null);
      return this.toStatus(updated);
    });
  }

  /** New recovery codes replace every old one — for when the printed sheet is lost, or most are used up. */
  async regenerateRecoveryCodes(tenantId: string, userId: string, code: string): Promise<{ recoveryCodes: string[]; status: MfaStatus }> {
    await this.requireSecondFactor(tenantId, userId, code);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const recoveryCodes = generateRecoveryCodes();
      const updated = await tx.user.update({ where: { id: userId }, data: { mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode) } });
      await this.audit(tx, tenantId, userId, 'auth.mfa_recovery_codes_regenerated', userId, null);
      return { recoveryCodes, status: this.toStatus(updated) };
    });
  }

  /**
   * An owner switching it off for a colleague whose phone is lost and whose
   * recovery codes are gone. Never for themselves: an owner in that position
   * uses a recovery code, and allowing it would make an open owner session a
   * way round the owner's own second factor.
   */
  async resetForUser(tenantId: string, actor: JwtPayload, targetUserId: string): Promise<{ reset: true }> {
    // The route is owner-only already; this keeps the rule true for any other caller of the service.
    if (!actor.roles.some((role) => role.role === String(SystemRole.Owner))) {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Only an owner can reset someone’s two-step sign-in' });
    }
    if (actor.sub === targetUserId) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Use one of your recovery codes, or turn it off from My Account.' });
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const target = await tx.user.findFirst({ where: { id: targetUserId } });
      if (!target) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Staff member not found' });
      if (!target.mfaEnabledAt && !target.mfaSecret) return { reset: true as const };
      await tx.user.update({ where: { id: targetUserId }, data: this.clearedMfa() });
      await this.audit(tx, tenantId, actor.sub, 'auth.mfa_reset', targetUserId, { resetFor: target.email });
      return { reset: true as const };
    });
  }

  /**
   * Checks a code against the user's second factor and commits the
   * consequences in its own transaction: on success the step (or the spent
   * recovery code) is recorded so it can't be used again; on failure the
   * count goes up and, at the limit, the account's second step is locked.
   *
   * Both successful paths are conditional updates — a code is only accepted
   * if the row still says it hasn't been used — so two requests racing with
   * the same code can't both get in.
   */
  async checkSecondFactor(tenantId: string, userId: string, code: string, now = new Date()): Promise<SecondFactorResult> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const user = await this.loadUser(tx, userId);
      if (!user.mfaEnabledAt || !user.mfaSecret) return { ok: false, lockedUntil: null, attemptsLeft: 0 };
      if (user.mfaLockedUntil && user.mfaLockedUntil > now) return { ok: false, lockedUntil: user.mfaLockedUntil, attemptsLeft: 0 };

      const trimmed = code.trim();
      if (/^\d{6}$/.test(trimmed.replace(/\s/g, ''))) {
        const step = verifyTotp(this.encryption.decrypt(user.mfaSecret), trimmed, now.getTime(), user.mfaLastUsedStep);
        if (step !== null) {
          const claimed = await tx.user.updateMany({
            where: { id: userId, OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }] },
            data: { mfaLastUsedStep: step, mfaFailedAttempts: 0, mfaLockedUntil: null },
          });
          if (claimed.count === 1) return { ok: true, method: 'totp', recoveryCodesLeft: user.mfaRecoveryCodes.length };
        }
      } else if (looksLikeRecoveryCode(trimmed)) {
        const hash = hashRecoveryCode(trimmed);
        // array_remove inside one UPDATE: atomic, and leaves any other code a
        // concurrent request is spending untouched.
        const spent = await tx.$executeRaw`
          UPDATE "users" SET "mfaRecoveryCodes" = array_remove("mfaRecoveryCodes", ${hash}), "mfaFailedAttempts" = 0, "mfaLockedUntil" = NULL
          WHERE "id" = ${userId}::uuid AND ${hash} = ANY("mfaRecoveryCodes")`;
        if (spent === 1) {
          await this.audit(tx, tenantId, userId, 'auth.mfa_recovery_code_used', userId, { recoveryCodesLeft: user.mfaRecoveryCodes.length - 1 });
          return { ok: true, method: 'recovery', recoveryCodesLeft: user.mfaRecoveryCodes.length - 1 };
        }
      }

      const failures = user.mfaFailedAttempts + 1;
      const lockedUntil = failures >= MFA_MAX_FAILED_ATTEMPTS ? new Date(now.getTime() + MFA_LOCK_MINUTES * 60_000) : null;
      await tx.user.update({
        where: { id: userId },
        data: lockedUntil ? { mfaFailedAttempts: 0, mfaLockedUntil: lockedUntil } : { mfaFailedAttempts: failures },
      });
      await this.audit(tx, tenantId, userId, lockedUntil ? 'auth.mfa_locked' : 'auth.mfa_failed', userId, { failures });
      return { ok: false, lockedUntil, attemptsLeft: lockedUntil ? 0 : MFA_MAX_FAILED_ATTEMPTS - failures };
    });
  }

  /** `checkSecondFactor`, turned into the right error for an account-settings action. */
  async requireSecondFactor(tenantId: string, userId: string, code: string): Promise<void> {
    const result = await this.checkSecondFactor(tenantId, userId, code);
    if (!result.ok) throw this.failureFor(result);
  }

  failureFor(result: Extract<SecondFactorResult, { ok: false }>): HttpException {
    if (result.lockedUntil) {
      const minutes = Math.max(1, Math.ceil((result.lockedUntil.getTime() - Date.now()) / 60_000));
      return new HttpException(
        { code: ErrorCode.MFA_LOCKED, message: `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return new UnauthorizedException({
      code: ErrorCode.MFA_INVALID_CODE,
      message:
        result.attemptsLeft > 0
          ? `That code isn’t right. ${result.attemptsLeft} more ${result.attemptsLeft === 1 ? 'try' : 'tries'} before a ${MFA_LOCK_MINUTES}-minute pause.`
          : 'That code isn’t right.',
    });
  }

  private async assertPassword(tenantId: string, userId: string, password: string): Promise<void> {
    const user = await this.prisma.withTenant(tenantId, (tx) => this.loadUser(tx, userId));
    if (!user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException({ code: ErrorCode.INVALID_CREDENTIALS, message: 'That password isn’t right' });
    }
  }

  private async loadUser(tx: TenantTx, userId: string): Promise<User> {
    const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'User not found' });
    return user;
  }

  private clearedMfa(): Prisma.UserUpdateInput {
    return { mfaSecret: null, mfaEnabledAt: null, mfaLastUsedStep: null, mfaFailedAttempts: 0, mfaLockedUntil: null, mfaRecoveryCodes: [] };
  }

  private toStatus(user: User): MfaStatus {
    return {
      enabled: user.mfaEnabledAt !== null,
      enabledAt: user.mfaEnabledAt,
      pendingSetup: user.mfaEnabledAt === null && user.mfaSecret !== null,
      recoveryCodesLeft: user.mfaEnabledAt ? user.mfaRecoveryCodes.length : 0,
    };
  }

  private async audit(tx: TenantTx, tenantId: string, userId: string, action: string, entityId: string, after: Prisma.InputJsonValue | null): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, userId, action, entityType: 'user', entityId, ...(after ? { after } : {}) } });
  }
}

