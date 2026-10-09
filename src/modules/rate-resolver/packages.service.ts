import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Package, Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { TaxesService } from '../taxes/taxes.service';
import { CreatePackageDto, UpdatePackageDto } from './dto/package.dto';
import { PackageSnapshot, packageTotal, postingsFor } from './package-pricing';

export interface PackageView {
  id: string;
  name: string;
  description: string | null;
  price: string;
  basis: PackageSnapshot['basis'];
  chargeType: string;
  roomTypeIds: string[];
  showOnline: boolean;
  isActive: boolean;
  sortOrder: number | null;
}

/** What a stay's packages come to, priced by the branch's tax rules for each one's charge type. */
export interface PackagesQuote {
  lines: Array<{ packageId: string; name: string; basis: PackageSnapshot['basis']; amount: string; tax: string; total: string }>;
  subtotal: string;
  taxTotal: string;
  total: string;
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

function toView(pkg: Package): PackageView {
  return {
    id: pkg.id,
    name: pkg.name,
    description: pkg.description,
    price: pkg.price.toFixed(2),
    basis: pkg.basis as PackageSnapshot['basis'],
    chargeType: pkg.chargeType,
    roomTypeIds: pkg.roomTypeIds,
    showOnline: pkg.showOnline,
    isActive: pkg.isActive,
    sortOrder: pkg.sortOrder,
  };
}

/**
 * Packages: things sold with a stay at a set price — breakfast for two a
 * night, an airport pick-up once. A stay adds them when it's booked and
 * keeps each one as priced then; each posts to the bill as a charge of its
 * own type (breakfast as food and drink, a pick-up as transport), with the
 * night or, for a per-stay one, at check-in.
 */
@Injectable()
export class PackagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    private readonly taxesService: TaxesService,
  ) {}

  async list(tenantId: string, branchId: string, options: { roomTypeId?: string; online?: boolean } = {}): Promise<PackageView[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const packages = await tx.package.findMany({
        where: {
          branchId,
          deletedAt: null,
          ...(options.online ? { isActive: true, showOnline: true } : {}),
          ...(options.roomTypeId ? { OR: [{ roomTypeIds: { isEmpty: true } }, { roomTypeIds: { has: options.roomTypeId } }] } : {}),
        },
        orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      });
      return packages.map(toView);
    });
  }

  async create(tenantId: string, branchId: string, dto: CreatePackageDto, actorId: string): Promise<PackageView> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      await this.assertRoomTypes(tx, branchId, dto.roomTypeIds ?? []);
      const pkg = await tx.package.create({
        data: {
          tenantId,
          branchId,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          price: new Prisma.Decimal(dto.price),
          basis: dto.basis,
          chargeType: dto.chargeType,
          roomTypeIds: dto.roomTypeIds ?? [],
          showOnline: dto.showOnline ?? true,
          sortOrder: dto.sortOrder,
        },
      });
      await this.audit(tx, tenantId, branchId, actorId, 'package.created', pkg.id, { name: pkg.name, price: pkg.price.toFixed(2), basis: pkg.basis });
      return toView(pkg);
    });
  }

  async update(tenantId: string, packageId: string, dto: UpdatePackageDto, actorId: string): Promise<PackageView> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await this.findOrThrow(tx, packageId);
      if (dto.roomTypeIds) await this.assertRoomTypes(tx, existing.branchId, dto.roomTypeIds);
      const pkg = await tx.package.update({
        where: { id: packageId },
        data: {
          name: dto.name?.trim(),
          description: dto.description === undefined ? undefined : dto.description?.trim() || null,
          price: dto.price === undefined ? undefined : new Prisma.Decimal(dto.price),
          basis: dto.basis,
          chargeType: dto.chargeType,
          roomTypeIds: dto.roomTypeIds,
          showOnline: dto.showOnline,
          isActive: dto.isActive,
          sortOrder: dto.sortOrder,
        },
      });
      await this.audit(tx, tenantId, existing.branchId, actorId, 'package.updated', pkg.id, { fields: Object.keys(dto) });
      return toView(pkg);
    });
  }

  /** Taken off the list; stays already holding it keep it as priced. */
  async remove(tenantId: string, packageId: string, actorId: string): Promise<{ removed: true }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await this.findOrThrow(tx, packageId);
      await tx.package.update({ where: { id: packageId }, data: { deletedAt: new Date(), isActive: false } });
      await this.audit(tx, tenantId, existing.branchId, actorId, 'package.removed', packageId, { name: existing.name });
      return { removed: true };
    });
  }

  /**
   * The packages picked for a stay, as the stay will keep them. Each has to be
   * on sale at this property, for this room type — and, booked online, offered
   * online.
   */
  async snapshotsFor(tx: TenantTx, branchId: string, roomTypeId: string, packageIds: string[], options: { online?: boolean } = {}): Promise<PackageSnapshot[]> {
    const ids = [...new Set(packageIds)];
    if (ids.length === 0) return [];
    const packages = await tx.package.findMany({ where: { id: { in: ids }, branchId, deletedAt: null, isActive: true } });
    for (const id of ids) {
      const pkg = packages.find((p) => p.id === id);
      if (!pkg || (options.online && !pkg.showOnline)) throw invalid('That package is not on offer');
      if (pkg.roomTypeIds.length > 0 && !pkg.roomTypeIds.includes(roomTypeId)) throw invalid(`${pkg.name} doesn't come with that room`);
    }
    return ids.map((id) => {
      const pkg = packages.find((p) => p.id === id) as Package;
      return { packageId: pkg.id, name: pkg.name, price: pkg.price.toFixed(2), basis: pkg.basis as PackageSnapshot['basis'], chargeType: pkg.chargeType };
    });
  }

  /** What packages come to for a stay of `nights` for `guests` people, tax by the branch's rules for each one's charge type. */
  /** Packages priced for a stay, by id — the booking screens' quote and the public one. */
  async quoteForStay(
    tenantId: string,
    branchId: string,
    stay: { roomTypeId: string; packageIds: string[]; nights: number; guests: number },
    options: { online?: boolean } = {},
  ): Promise<PackagesQuote> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const snapshots = await this.snapshotsFor(tx, branchId, stay.roomTypeId, stay.packageIds, options);
      return this.quote(tx, branchId, snapshots, stay.nights, stay.guests);
    });
  }

  async quote(tx: TenantTx, branchId: string, packages: PackageSnapshot[], nights: number, guests: number): Promise<PackagesQuote> {
    const lines: PackagesQuote['lines'] = [];
    let subtotal = new Prisma.Decimal(0);
    let taxTotal = new Prisma.Decimal(0);
    let total = new Prisma.Decimal(0);
    for (const pkg of packages) {
      const amount = packageTotal(pkg, nights, guests);
      const priced = await this.taxesService.priceCharge(tx, branchId, pkg.chargeType, amount, postingsFor(pkg, nights));
      lines.push({ packageId: pkg.packageId, name: pkg.name, basis: pkg.basis, amount: amount.toFixed(2), tax: priced.addedTax.toFixed(2), total: priced.total.toFixed(2) });
      subtotal = subtotal.plus(amount);
      taxTotal = taxTotal.plus(priced.addedTax);
      total = total.plus(priced.total);
    }
    return { lines, subtotal: subtotal.toFixed(2), taxTotal: taxTotal.toFixed(2), total: total.toFixed(2) };
  }

  private async findOrThrow(tx: TenantTx, packageId: string): Promise<Package> {
    const pkg = await tx.package.findFirst({ where: { id: packageId, deletedAt: null } });
    if (!pkg) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Package not found' });
    return pkg;
  }

  private async assertRoomTypes(tx: TenantTx, branchId: string, roomTypeIds: string[]): Promise<void> {
    if (roomTypeIds.length === 0) return;
    const found = await tx.roomType.count({ where: { id: { in: roomTypeIds }, branchId, deletedAt: null } });
    if (found !== new Set(roomTypeIds).size) throw invalid('Pick room types of this property');
  }

  private async audit(tx: TenantTx, tenantId: string, branchId: string, userId: string, action: string, entityId: string, after: Prisma.InputJsonValue): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, branchId, userId, action, entityType: 'package', entityId, after } });
  }
}
