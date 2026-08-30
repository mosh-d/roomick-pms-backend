import { Injectable, NotFoundException } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';

export interface TenantFeatureFlag {
  id: string;
  name: string;
  enabledForThisTenant: boolean;
  rolloutPct: number | null;
  updatedAt: Date;
}

/**
 * System Admin's "Feature Flags" card (ref: "Enable/disable features per
 * tenant or user"). `FeatureFlag` has existed in the schema since P0 —
 * confirmed via grep that literally nothing in `src/` ever referenced it —
 * pure scaffolding until this pass.
 *
 * Deliberately tenant-scoped self-service, not a platform admin console:
 * there is no cross-tenant "SysAdmin" role anywhere in this app's auth
 * model (every `@Roles()` guard and the JWT's own `tenantId` claim are
 * single-tenant) — see the note on `enabledForTenants` below for why this
 * matters for what gets exposed, not just what gets written.
 */
@Injectable()
export class FeatureFlagsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `FeatureFlag` is a global, non-RLS table (like `BackupRecord`) — a
   * plain `findMany`, not a `withTenant` transaction. Critically, the raw
   * `enabledForTenants` array is NEVER returned to a caller: it holds
   * every opted-in tenant's UUID, and handing that back to any Owner would
   * leak which OTHER tenants have a given flag on — a real cross-tenant
   * data leak this shape avoids by resolving down to one boolean.
   */
  async listFlags(tenantId: string): Promise<TenantFeatureFlag[]> {
    const flags = await this.prisma.featureFlag.findMany({ orderBy: { name: 'asc' } });
    return flags.map((f) => ({
      id: f.id,
      name: f.name,
      enabledForThisTenant: f.enabledGlobally || f.enabledForTenants.includes(tenantId),
      rolloutPct: f.rolloutPct,
      updatedAt: f.updatedAt,
    }));
  }

  /**
   * Adds/removes the CALLING tenant's own id to/from `enabledForTenants` —
   * never touches `enabledGlobally`, `rolloutPct`, or any other tenant's
   * membership. Creating new flags, or rolling one out globally, stays
   * genuine platform/engineering territory this pass doesn't build a
   * console for (see the module's own header comment).
   */
  async setEnabledForTenant(tenantId: string, flagId: string, enabled: boolean): Promise<TenantFeatureFlag> {
    const flag = await this.prisma.featureFlag.findUnique({ where: { id: flagId } });
    if (!flag) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Feature flag not found' });

    const nextTenants = enabled
      ? flag.enabledForTenants.includes(tenantId)
        ? flag.enabledForTenants
        : [...flag.enabledForTenants, tenantId]
      : flag.enabledForTenants.filter((id) => id !== tenantId);

    const updated = await this.prisma.featureFlag.update({
      where: { id: flagId },
      data: { enabledForTenants: nextTenants, updatedBy: tenantId },
    });

    return {
      id: updated.id,
      name: updated.name,
      enabledForThisTenant: updated.enabledGlobally || updated.enabledForTenants.includes(tenantId),
      rolloutPct: updated.rolloutPct,
      updatedAt: updated.updatedAt,
    };
  }

  /**
   * For future real gating — unused by any business logic today, the same
   * "stored/resolvable but not yet enforced anywhere" honesty already
   * established for the Permission Matrix's own stored-but-unenforced
   * permissions.
   */
  async isEnabledForTenant(tenantId: string, flagName: string): Promise<boolean> {
    const flag = await this.prisma.featureFlag.findUnique({ where: { name: flagName } });
    if (!flag) return false;
    return flag.enabledGlobally || flag.enabledForTenants.includes(tenantId);
  }
}
