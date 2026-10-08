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
 */
@Injectable()
export class AccountStatusService {
  /** Accounts known to be open, by user id → when that answer lapses, and the organisation it belongs to. */
  private readonly open = new Map<string, { until: number; tenantId: string }>();

  constructor(private readonly prisma: PrismaService) {}

  async check(user: Pick<JwtPayload, 'sub' | 'tenantId'>, now = Date.now()): Promise<AccountState> {
    const known = this.open.get(user.sub);
    if (known !== undefined && known.until > now) return 'open';

    const [row, tenant] = await Promise.all([
      this.prisma.withTenant(user.tenantId, (tx) => tx.user.findFirst({ where: { id: user.sub, deletedAt: null }, select: { id: true } })),
      this.prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { status: true } }),
    ]);
    if (!row) {
      this.open.delete(user.sub);
      return 'closed';
    }
    if (!tenant || !isTenantOpen(tenant.status)) {
      this.open.delete(user.sub);
      return 'suspended';
    }
    if (this.open.size >= SWEEP_ABOVE) this.sweep(now);
    this.open.set(user.sub, { until: now + ACCOUNT_STATUS_TTL_MS, tenantId: user.tenantId });
    return 'open';
  }

  async isOpen(user: Pick<JwtPayload, 'sub' | 'tenantId'>, now = Date.now()): Promise<boolean> {
    return (await this.check(user, now)) === 'open';
  }

  /** The account was deactivated or deleted — the next request reads the row again instead of trusting a remembered answer. */
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
