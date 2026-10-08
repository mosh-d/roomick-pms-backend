import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../types/request-context';
import { isTenantOpen } from './tenant-status';

/** How long a "this account is still open" answer is kept before the rows are read again. */
export const ACCOUNT_STATUS_TTL_MS = 30_000;

/** Past this many remembered accounts, the ones whose answers have lapsed are dropped. */
const SWEEP_ABOVE = 5_000;

/**
 * `open` — the person still has an account and their organisation is trial or active.
 * `closed` — the person was deactivated, or the organisation deleted.
 * `suspended` — the person is fine, but the organisation is suspended or cancelled.
 */
export type AccountState = 'open' | 'closed' | 'suspended';

/** The roles a person holds, in the access token's own shape. */
export type HeldRoles = JwtPayload['roles'];

/**
 * Whether the person behind an access token may still work.
 *
 * An access token is good for fifteen minutes on its own. Without this,
 * someone deactivated — or whose whole organisation was deleted — kept
 * working until it ran out, and the routes that then looked them up failed
 * with a 500 instead of a 401. `JwtAuthGuard` asks here on every signed-in
 * request; the answer is two indexed reads per person every thirty seconds
 * at most, and a deactivation in this process takes effect at once
 * (`forget`). Across several processes it takes effect within the TTL.
 *
 * The organisation's own status is part of the answer: a suspended or
 * cancelled organisation's staff are refused the same way API keys and the
 * public booking page already refuse it — it used to be checked nowhere on
 * the staff side, so "suspend" did nothing for the people in the app.
 *
 * So are the roles the person holds now. The token carries the roles it was
 * issued with; a manager taken down to front desk, or a role removed, kept
 * the old access until the token was renewed — up to fifteen minutes.
 * `JwtAuthGuard` puts these in its place, so a change counts within the TTL,
 * and at once in this process (`forget`).
 */
@Injectable()
export class AccountStatusService {
  /** Accounts known to be open, by user id → when that answer lapses, and the organisation it belongs to. */
  private readonly open = new Map<string, { until: number; tenantId: string; roles: HeldRoles }>();

  constructor(private readonly prisma: PrismaService) {}

  async check(user: Pick<JwtPayload, 'sub' | 'tenantId'>, now = Date.now()): Promise<AccountState> {
    return (await this.current(user, now)).state;
  }

  /** The account's state, and — while it's open — the roles it holds right now. */
  async current(user: Pick<JwtPayload, 'sub' | 'tenantId'>, now = Date.now()): Promise<{ state: AccountState; roles: HeldRoles | null }> {
    const known = this.open.get(user.sub);
    if (known !== undefined && known.until > now) return { state: 'open', roles: known.roles };

    const [roles, tenant] = await Promise.all([
      this.prisma.withTenant(user.tenantId, async (tx) => {
        const row = await tx.user.findFirst({ where: { id: user.sub, deletedAt: null }, select: { id: true } });
        if (!row) return null;
        const assignments = await tx.userBranchRole.findMany({ where: { userId: user.sub }, select: { branchId: true, role: { select: { name: true } } } });
        return assignments.map((a) => ({ branchId: a.branchId, role: a.role.name }));
      }),
      this.prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { status: true } }),
    ]);
    if (!roles) {
      this.open.delete(user.sub);
      return { state: 'closed', roles: null };
    }
    if (!tenant || !isTenantOpen(tenant.status)) {
      this.open.delete(user.sub);
      return { state: 'suspended', roles: null };
    }
    if (this.open.size >= SWEEP_ABOVE) this.sweep(now);
    this.open.set(user.sub, { until: now + ACCOUNT_STATUS_TTL_MS, tenantId: user.tenantId, roles });
    return { state: 'open', roles };
  }

  async isOpen(user: Pick<JwtPayload, 'sub' | 'tenantId'>, now = Date.now()): Promise<boolean> {
    return (await this.check(user, now)) === 'open';
  }

  /** The account was deactivated or deleted, or its roles changed — the next request reads the rows again instead of trusting a remembered answer. */
  forget(userId: string): void {
    this.open.delete(userId);
  }

  /** The organisation's status changed — everyone in it is re-checked on their next request. */
  forgetTenant(tenantId: string): void {
    for (const [userId, entry] of this.open) {
      if (entry.tenantId === tenantId) this.open.delete(userId);
    }
  }

  private sweep(now: number): void {
    for (const [userId, entry] of this.open) {
      if (entry.until <= now) this.open.delete(userId);
    }
  }
}
