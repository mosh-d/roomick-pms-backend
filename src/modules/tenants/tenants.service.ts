import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Brand, Tenant } from '@prisma/client';
import { AccountStatusService } from '../../common/auth/account-status.service';
import { ErrorCode } from '../../common/errors/error-codes';
import { MfaService } from '../auth/mfa.service';
import { tenantModelInsertOrder } from '../../common/prisma/tenant-models';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigureModeDto } from './dto/configure-mode.dto';

/** How long a demo (self-serve "try it") tenant lives before the cleanup job sweeps it. */
export const DEMO_TENANT_TTL_DAYS = 30;

export function demoExpiryFromNow(): Date {
  return new Date(Date.now() + DEMO_TENANT_TTL_DAYS * 24 * 60 * 60 * 1000);
}

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountStatus: AccountStatusService,
    private readonly mfaService: MfaService,
  ) {}

  /**
   * Signup step 2 (spec §5): fixes single/multi-brand mode.
   * brandMode is immutable once the first brand exists (DB doc) — the
   * "head brand" row is always created here, in the same transaction,
   * regardless of mode. This used to only happen for `single` mode
   * (multi-mode tenants got no brand here, and the frontend called
   * `POST /brands` separately, on its own screen, right after) — changed
   * because there's no real reason to ask twice: the owner already named
   * their organization at signup (`groupName`), and a multi-brand tenant
   * still needs exactly one starting brand to do anything useful with
   * (branches attach to a brand, not a tenant). More brands are always
   * addable later via `POST /brands` (already unrestricted for multi-mode
   * tenants — see `createBrand`); this just removes the redundant
   * separate step for the *first* one. The backend never special-cases
   * single-brand afterwards otherwise (spec §1.1).
   */
  async configureMode(
    tenantId: string,
    dto: ConfigureModeDto,
    actorUserId: string,
  ): Promise<{ tenant: Tenant; brand: Brand }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existingBrands = await tx.brand.count({ where: { deletedAt: null } });
      if (existingBrands > 0) {
        throw new ConflictException({
          code: ErrorCode.BRAND_MODE_ALREADY_CONFIGURED,
          message: 'Brand mode is immutable after the first brand is created',
        });
      }

      const current = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const brand = await tx.brand.create({
        data: { tenantId, name: dto.brandName ?? current.groupName },
      });

      // tenants is the RLS root (no tenantId column) — writable inside the
      // same tx, keeping mode + head brand + audit atomic.
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
          after: { mode: dto.mode, brandId: brand.id },
        },
      });
      return { tenant, brand };
    });
  }

  /**
   * Powers the signup wizard's "you already have an account — log in and
   * continue where you left off" path (frontend: `RegisterForm`'s
   * `SUBDOMAIN_TAKEN`/`EMAIL_TAKEN` handling). Nothing here is `/auth/
   * login`-specific — it's a plain read of how far onboarding has actually
   * gotten on the backend, keyed off whatever's already authenticated
   * (JWT + tenant context), so the frontend can rehydrate its local wizard
   * draft to match reality instead of either losing progress (a blank
   * wizard) or re-attempting steps that already succeeded (a second
   * `configure-mode` call failing with `BRAND_MODE_ALREADY_CONFIGURED`).
   *
   * Walks the same brand → branch → room type → rooms chain Review's
   * "Finish" creates, stopping at the first missing link — a tenant that
   * only has a brand gets `branch: null` back (nothing deeper is queried,
   * there's nothing there yet). `roomCount` is a plain count, not a list —
   * the frontend only needs to know rooms exist and how many, not
   * reconstruct the exact range that created them.
   */
  async getOnboardingStatus(tenantId: string, userId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [tenant, user] = await Promise.all([
        tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
        tx.user.findUniqueOrThrow({ where: { id: userId } }),
      ]);

      const brand = await tx.brand.findFirst({
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      const branch = brand
        ? await tx.branch.findFirst({ where: { brandId: brand.id, deletedAt: null }, orderBy: { createdAt: 'asc' } })
        : null;
      const roomType = branch
        ? await tx.roomType.findFirst({ where: { branchId: branch.id, deletedAt: null }, orderBy: { createdAt: 'asc' } })
        : null;
      const roomCount = branch ? await tx.room.count({ where: { branchId: branch.id, deletedAt: null } }) : 0;

      return {
        tenant: {
          groupName: tenant.groupName,
          subdomain: tenant.subdomain,
          country: tenant.country,
          brandMode: tenant.brandMode,
        },
        user: { name: user.name, email: user.email, phone: user.phone },
        brand: brand ? { id: brand.id, name: brand.name } : null,
        branch: branch
          ? {
              id: branch.id,
              name: branch.name,
              category: branch.category,
              address: branch.address as { street: string; city: string; state?: string; country: string; zip?: string },
              timezone: branch.timezone,
              currency: branch.currency,
              checkInTime: branch.checkInTime.toISOString().slice(11, 16),
              checkOutTime: branch.checkOutTime.toISOString().slice(11, 16),
            }
          : null,
        roomType: roomType
          ? {
              id: roomType.id,
              name: roomType.name,
              baseRate: Number(roomType.baseRate),
              capacity: roomType.capacity as { adults: number; children: number },
              bedType: roomType.bedType,
              sizeM2: roomType.sizeM2 ? Number(roomType.sizeM2) : null,
              amenities: roomType.amenities,
            }
          : null,
        roomCount,
      };
    });
  }

  /**
   * The owner deleting their own organisation — their password first. This
   * is the one action in the app with no way back, so a stolen session or a
   * mis-click on the wrong account mustn't be enough.
   */
  async deleteOrganizationAsOwner(tenantId: string, actorId: string, password: string, mfaCode?: string): Promise<void> {
    const owner = await this.prisma.withTenant(tenantId, (tx) => tx.user.findFirst({ where: { id: actorId, deletedAt: null } }));
    if (!owner?.passwordHash || !(await bcrypt.compare(password, owner.passwordHash))) {
      throw new UnauthorizedException({ code: ErrorCode.INVALID_CREDENTIALS, message: 'That isn’t your password' });
    }
    // An owner with two-step sign-in proves the second step here too — a
    // stolen password alone used to be enough to erase the whole organisation.
    if (owner.mfaEnabledAt) {
      if (!mfaCode) {
        throw new UnauthorizedException({ code: ErrorCode.MFA_REQUIRED, message: 'Enter the code from your authenticator app as well' });
      }
      const result = await this.mfaService.checkSecondFactor(tenantId, actorId, mfaCode);
      if (!result.ok) throw this.mfaService.failureFor(result);
    }
    await this.deleteOrganization(tenantId);
  }

  /**
   * Removes an organisation and everything in it, in ONE transaction: every
   * tenant table children-first (the order the backup restore inserts in,
   * reversed — read off the schema, so a new table is never forgotten), the
   * sign-in email index, then the tenant row itself. Nothing is deleted
   * unless all of it is.
   *
   * It used to delete five tables and then the tenant, trusting cascades.
   * Most tables refuse deletion while they have rows, so any organisation
   * with a guest or a booking failed halfway: its users and branches gone,
   * the tenant and guests left behind, and the owner's email still in the
   * index — unable to sign in and unable to sign up again, for good.
   *
   * `tenants` sits outside row-level security; the tenant tables don't, so
   * the tenant is set for the transaction before anything is touched.
   */
  async deleteOrganization(tenantId: string): Promise<void> {
    const childrenFirst = [...tenantModelInsertOrder()].reverse();
    const people = await this.prisma.withTenant(tenantId, (tx) => tx.user.findMany({ select: { id: true } }));
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        const tables = tx as unknown as Record<string, { updateMany: (args: object) => Promise<unknown>; deleteMany: (args: object) => Promise<unknown> }>;
        // A link that closes a cycle — a stay's master bill, whose own stay
        // points back at it — is cut first, so either table can go first.
        for (const meta of childrenFirst) {
          for (const relation of meta.deferred) {
            await tables[meta.accessor].updateMany({ where: { tenantId }, data: Object.fromEntries(relation.fieldNames.map((field) => [field, null])) });
          }
        }
        for (const meta of childrenFirst) {
          await tables[meta.accessor].deleteMany({ where: { tenantId } });
        }
        await tx.userEmailIndex.deleteMany({ where: { tenantId } });
        // Backup files stay until their retention runs out (BackupsService
        // prunes them); their records just stop belonging to anyone.
        await tx.backupRecord.updateMany({ where: { tenantId }, data: { tenantId: null } });
        await tx.tenant.delete({ where: { id: tenantId } });
      },
      { timeout: 120_000 },
    );
    // Their access tokens are refused from now, not when they run out.
    for (const person of people) this.accountStatus.forget(person.id);
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
