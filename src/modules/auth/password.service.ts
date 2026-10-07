import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import { ErrorCode } from '../../common/errors/error-codes';
import { AccountMailService } from '../../common/mail/account-mail.service';
import { JwtPayload } from '../../common/types/request-context';
import { assertMayManageAccount } from '../../common/utils/staff-authority';
import { webUrl } from '../../common/utils/web-url';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { AuthService, BCRYPT_COST, LoginResult } from './auth.service';

/** A link someone asked for themselves: short, since it sits in an inbox. */
export const SELF_SERVICE_MINUTES = 60;
/** A link a manager makes to hand over: a working day to pass it on. */
export const HANDED_OVER_MINUTES = 24 * 60;
/** One email a minute per account, whatever the per-IP limit allows — nobody's inbox gets flooded. */
const RESEND_GAP_MS = 60_000;

const LINK_INVALID = { code: ErrorCode.TOKEN_INVALID, message: 'This reset link has expired or was already used — ask for a new one' };

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Passwords: changing your own, the "forgot your password?" email, and the
 * link an owner or manager makes for a colleague who's locked out.
 *
 * A reset link is `<tenantId>.<secret>` like an invite (the tenant half sets
 * the row-level-security context before anyone is signed in), but only a hash
 * of the secret is stored — a database copy can't be turned into working
 * links. Links are single-use, and using one, or changing a password, ends
 * every session the account had: whoever knew the old password is signed out.
 * Two-step sign-in is untouched — a new password still needs the code.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountMail: AccountMailService,
    private readonly authService: AuthService,
  ) {}

  /**
   * "Forgot your password?". Answers at once and the same for any address,
   * known or not — the work happens after the response, so neither the
   * answer nor how long it takes says whether an account exists. Until an
   * email provider is set up there's nowhere to send a link, which the answer
   * does say (it's about the system, not the account): then it's a manager,
   * or the owner, who makes one.
   */
  forgot(email: string): { emailEnabled: boolean } {
    if (!this.accountMail.delivers) return { emailEnabled: false };
    void this.sendResetLink(email).catch((err: unknown) => {
      this.logger.error(`Password reset for ${email} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { emailEnabled: true };
  }

  /** The work behind `forgot` — exported for its tests, never called by a route directly. */
  async sendResetLink(email: string): Promise<void> {
    const indexRow = await this.prisma.userEmailIndex.findUnique({ where: { email } });
    if (!indexRow) return;
    const issued = await this.prisma.withTenant(indexRow.tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: indexRow.userId, deletedAt: null } });
      if (!user) return null;
      const recent = await tx.passwordResetToken.findFirst({
        where: { userId: user.id, createdBy: null, createdAt: { gt: new Date(Date.now() - RESEND_GAP_MS) } },
      });
      if (recent) return null;
      const link = await this.issue(tx, user, SELF_SERVICE_MINUTES, null);
      await this.audit(tx, user.tenantId, user.id, 'auth.password_reset_requested', user.id, { by: 'email' });
      return { user, link };
    });
    if (issued) await this.accountMail.passwordReset(issued.user.email, issued.user.name, issued.link, SELF_SERVICE_MINUTES);
  }

  /**
   * A link for a colleague, made from Staff Management. The owner can make
   * one for anyone but themselves; a manager only for staff below them whose
   * every role is at a branch that manager runs. It's emailed to the person
   * when email is set up, and always shown to whoever made it, to hand over.
   */
  async createLink(actor: JwtPayload, userId: string): Promise<{ link: string; emailed: boolean; expiresAt: Date }> {
    const issued = await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null } });
      if (!user) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Staff member not found — or their account is deactivated' });
      const held = await tx.userBranchRole.findMany({ where: { userId }, include: { role: { select: { name: true } } } });
      assertMayManageAccount(actor, userId, held.map((h) => ({ branchId: h.branchId, role: h.role.name })));
      const link = await this.issue(tx, user, HANDED_OVER_MINUTES, actor.sub);
      await this.audit(tx, actor.tenantId, actor.sub, 'auth.password_reset_link_created', user.id, { for: user.email });
      return { user, link };
    });
    const emailed = await this.accountMail.passwordReset(issued.user.email, issued.user.name, issued.link, HANDED_OVER_MINUTES);
    return { link: issued.link, emailed, expiresAt: new Date(Date.now() + HANDED_OVER_MINUTES * 60_000) };
  }

  /** Using a link: a new password, every session ended. Then they sign in — two-step sign-in included. */
  async reset(publicToken: string, password: string): Promise<{ reset: true }> {
    const dot = publicToken.indexOf('.');
    const tenantId = dot > 0 ? publicToken.slice(0, dot) : '';
    const secret = dot > 0 ? publicToken.slice(dot + 1) : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId) || secret.length < 32) {
      throw new BadRequestException(LINK_INVALID);
    }
    // Hashed before the transaction, which then stays short; a bad link costs the same either way.
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    await this.prisma.withTenant(tenantId, async (tx) => {
      const now = new Date();
      const row = await tx.passwordResetToken.findUnique({ where: { tokenHash: hashSecret(secret) } });
      if (!row || row.usedAt || row.expiresAt <= now) throw new BadRequestException(LINK_INVALID);
      // Conditional, so two tabs racing with the same link can't both use it.
      const claimed = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count === 0) throw new BadRequestException(LINK_INVALID);
      const user = await tx.user.findFirst({ where: { id: row.userId, deletedAt: null } });
      if (!user) throw new BadRequestException(LINK_INVALID);

      await tx.user.update({
        where: { id: user.id },
        // A link the person asked for went to their inbox, which proves the
        // address; one a manager made and handed over proves nothing about it.
        data: { passwordHash, ...(row.createdBy === null ? { emailVerified: true } : {}) },
      });
      await this.endEverything(tx, user.id, now);
      await this.audit(tx, tenantId, user.id, 'auth.password_reset', user.id, { linkFrom: row.createdBy === null ? 'email' : 'staff_management' });
    });
    return { reset: true };
  }

  /**
   * Changing your own password, from My Account. Every session ends —
   * including other browsers someone else might be using — and this one
   * carries on with a fresh session, returned here.
   */
  async changePassword(actor: JwtPayload, currentPassword: string, newPassword: string): Promise<LoginResult> {
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: actor.sub, deletedAt: null } });
      if (!user) throw new UnauthorizedException({ code: ErrorCode.TOKEN_INVALID, message: 'Your session has ended — sign in again' });
      // 400, not 401: the session is fine, the password typed isn't — a 401
      // would send the app off renewing a session that needs no renewing.
      if (!user.passwordHash || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
        throw new BadRequestException({ code: ErrorCode.INVALID_CREDENTIALS, message: 'That isn’t your current password' });
      }
      if (await bcrypt.compare(newPassword, user.passwordHash)) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Choose a password different from the one you have now' });
      }
      const now = new Date();
      const updated = await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await this.endEverything(tx, user.id, now);
      await this.audit(tx, actor.tenantId, user.id, 'auth.password_changed', user.id);
      return this.authService.startSession(tx, updated);
    });
  }

  /** A new single-use link; any older one for the same person stops working. */
  private async issue(tx: TenantTx, user: User, validForMinutes: number, createdBy: string | null): Promise<string> {
    const now = new Date();
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
    const secret = randomBytes(32).toString('hex');
    await tx.passwordResetToken.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        tokenHash: hashSecret(secret),
        expiresAt: new Date(now.getTime() + validForMinutes * 60_000),
        createdBy,
      },
    });
    return webUrl(`/reset-password?token=${encodeURIComponent(`${user.tenantId}.${secret}`)}`);
  }

  /** Every session, and every other reset link, for this person — over. */
  private async endEverything(tx: TenantTx, userId: string, now: Date): Promise<void> {
    await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
  }

  private async audit(tx: TenantTx, tenantId: string, userId: string | null, action: string, entityId: string, after?: Record<string, string>): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, userId, action, entityType: 'user', entityId, after } });
  }
}
