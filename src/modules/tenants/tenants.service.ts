import { ConflictException, Injectable } from '@nestjs/common';
import { Brand, Tenant } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { BrandModeInput, ConfigureModeDto } from './dto/configure-mode.dto';

@Injectable()
export class TenantsService {
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
}
