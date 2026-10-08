import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../types/request-context';

/** How long a "this account is still open" answer is kept before the row is read again. */
export const ACCOUNT_STATUS_TTL_MS = 30_000;

/** Past this many remembered accounts, the ones whose answers have lapsed are dropped. */
const SWEEP_ABOVE = 5_000;

/**
 * Whether the person behind an access token still has an account.
 *
 * An access token is good for fifteen minutes on its own. Without this,
 * someone deactivated — or whose whole organisation was deleted — kept
 * working until it ran out, and the routes that then looked them up failed
 * with a 500 instead of a 401. `JwtAuthGuard` asks here on every signed-in
 * request; the answer is one indexed read per person every thirty seconds
 * at most, and a deactivation in this process takes effect at once
 * (`forget`). Across several processes it takes effect within the TTL.
 */
@Injectable()
export class AccountStatusService {
  /** Accounts known to be open, by user id → when that answer lapses. */
  private readonly open = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async isOpen(user: Pick<JwtPayload, 'sub' | 'tenantId'>, now = Date.now()): Promise<boolean> {
    const until = this.open.get(user.sub);
    if (until !== undefined && until > now) return true;

    const row = await this.prisma.withTenant(user.tenantId, (tx) => tx.user.findFirst({ where: { id: user.sub, deletedAt: null }, select: { id: true } }));
    if (!row) {
      this.open.delete(user.sub);
      return false;
    }
    if (this.open.size >= SWEEP_ABOVE) this.sweep(now);
    this.open.set(user.sub, now + ACCOUNT_STATUS_TTL_MS);
    return true;
  }

  /** The account was deactivated or deleted — the next request reads the row again instead of trusting a remembered answer. */
  forget(userId: string): void {
    this.open.delete(userId);
  }

  private sweep(now: number): void {
    for (const [userId, until] of this.open) {
      if (until <= now) this.open.delete(userId);
    }
  }
}
