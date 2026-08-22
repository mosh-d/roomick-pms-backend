import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Brand, Tenant } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { BrandModeInput, ConfigureModeDto } from './dto/configure-mode.dto';

/** How long a demo (self-serve "try it") tenant lives before the cleanup job sweeps it. */
export const DEMO_TENANT_TTL_DAYS = 30;

export function demoExpiryFromNow(): Date {
  return new Date(Date.now() + DEMO_TENANT_TTL_DAYS * 24 * 60 * 60 * 1000);
}

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Signup step 2 (spec §5): fixes single/multi-brand mode.
   * brandMode is immutable once the first brand exists (DB doc) — in single
   * mode the hidden brand row is created here, in the same transaction.
   * The backend never special-cases single-brand afterwards (spec §1.1).
   */
  async configureMode(
    tenantId: string,
    dto: ConfigureModeDto,
    actorUserId: string,
  ): Promise<{ tenant: Tenant; brand: Brand | null }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existingBrands = await tx.brand.count({ where: { deletedAt: null } });
      if (existingBrands > 0) {
        throw new ConflictException({
          code: ErrorCode.BRAND_MODE_ALREADY_CONFIGURED,
          message: 'Brand mode is immutable after the first brand is created',
        });
      }

      let brand: Brand | null = null;
      if (dto.mode === BrandModeInput.single) {
        const current = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
        brand = await tx.brand.create({
          data: { tenantId, name: dto.brandName ?? current.groupName },
        });
      }

      // tenants is the RLS root (no tenantId column) — writable inside the
      // same tx, keeping mode + hidden brand + audit atomic.
      const tenant = await tx.tenant.update({
        where: { id: tenantId },
        data: { brandMode: dto.mode },
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actorUserId,
          action: 'tenant.configure_mode',
          entityType: 'tenant',
          entityId: tenantId,
          after: { mode: dto.mode, brandId: brand?.id ?? null },
        },
      });
      return { tenant, brand };
    });
  }

  /**
   * Deletes an organization entirely — the manual counterpart to the
   * scheduled demo-expiry sweep (see the cron in this same class). Real
   * ("full account deletion") support is future work; this pass only wires
   * up what a demo tenant can actually have accumulated through the
   * currently-built endpoints (auth + tenants + property/P1) — everything
   * else in the schema cascades automatically once those are gone (see the
   * reasoning below).
   *
   * Deletion order matters and is NOT arbitrary: the schema deliberately
   * `onDelete: Restrict`s a tenant's real financial/operational data
   * (reservations, folios, payments, audit logs, etc. — see the backend
   * README's "Money" invariant) so a tenant can't be silently cascade-wiped
   * if it has any of that. Nothing populates those tables yet (P2+), so for
   * a tenant created via the current signup/onboarding surface, only five
   * tables are `Restrict`-configured AND actually reachable today: Room,
   * RoomType, Branch, User, and — easy to miss, caught by actually running
   * this against a populated tenant rather than trusting the schema read —
   * AuditLog, which `AuditInterceptor` (see common/interceptors/) writes a
   * row to on *every* mutating request, so any tenant that's done anything
   * at all has rows there. Clear all five explicitly, in dependency order
   * (Room references RoomType/Branch; RoomType references Branch; Branch
   * references Brand; AuditLog and User only reference Tenant directly).
   * Everything else (Role, UserBranchRole, InviteToken, Brand, Building,
   * Floor, RoomBlock, Outlet, UserOutlet, OverbookingConfig, TaxRule, ...)
   * is `Cascade`-configured relative to Tenant/Branch/User and cleans up
   * automatically once the final `tenant.delete()` runs.
   *
   * If a tenant somehow does have real transactional data (shouldn't be
   * possible yet), the final delete fails with a DB constraint error
   * instead of silently destroying it — a deliberate fail-safe, not a bug
   * to fix in this pass.
   */
  async deleteOrganization(tenantId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.room.deleteMany({ where: { tenantId } });
      await tx.roomType.deleteMany({ where: { tenantId } });
      await tx.branch.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
    });

    // tenants is the RLS root (no RLS policy of its own — confirmed
    // directly readable/writable without a tenant context set), so this
    // runs outside withTenant(). Cascades Role/UserBranchRole/InviteToken/
    // Brand/Building/Floor/RoomBlock/Outlet/UserOutlet/OverbookingConfig/
    // TaxRule automatically.
    await this.prisma.tenant.delete({ where: { id: tenantId } });
    this.logger.log(`Tenant ${tenantId} deleted`);
  }

  /**
   * Nightly sweep for expired demo tenants — the automatic counterpart to
   * `deleteOrganization`. `@nestjs/schedule` (already used elsewhere —
   * app.module.ts's `ScheduleModule.forRoot()`) fires this once a day;
   * failures on one tenant are logged and don't block the rest of the
   * sweep, since one bad row shouldn't stop the others from being cleaned
   * up.
   *
   * `ScheduleModule.forRoot()` has been registered in app.module.ts since
   * P0 but never actually used until now — this is the first real
   * consumer.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async sweepExpiredDemoTenants(): Promise<void> {
    const expired = await this.prisma.tenant.findMany({
      where: { isDemo: true, demoExpiresAt: { lt: new Date() } },
      select: { id: true, subdomain: true },
    });

    for (const tenant of expired) {
      try {
        await this.deleteOrganization(tenant.id);
        this.logger.log(`Swept expired demo tenant ${tenant.subdomain} (${tenant.id})`);
      } catch (err) {
        this.logger.error(`Failed to sweep demo tenant ${tenant.subdomain} (${tenant.id})`, err);
      }
    }
  }
}
