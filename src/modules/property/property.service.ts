import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Brand, Branch, Building, Floor, OverbookingConfig, Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CreateBrandDto, UpdateBrandDto } from './dto/brand.dto';
import {
  CreateBranchDto,
  CancellationPolicyDto,
  DayUsePolicyDto,
  TurndownPolicyDto,
  DepositPolicyDto,
  StayFeePolicyDto,
  GuestTermsDto,
  NoShowPolicyDto,
  RegCardTemplateDto,
  UpdateBranchDto,
} from './dto/branch.dto';
import { UpdateOverbookingConfigDto } from './dto/overbooking-config.dto';
import { CreateBuildingDto, CreateFloorDto } from './dto/structure.dto';

/** "14:00" → DateTime on 1970-01-01 (Prisma @db.Time) */
export function timeStringToDate(time: string): Date {
  return new Date(`1970-01-01T${time}:00.000Z`);
}

function assertValidTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new BadRequestException({
      code: ErrorCode.INVALID_TIMEZONE,
      message: `'${tz}' is not a valid IANA timezone`,
    });
  }
}

/**
 * A branch's policies after an update: the keys sent replace those on file,
 * a key sent as `null` is removed, and every other key stays. The whole object
 * used to be replaced, so a client sending one policy wiped all the others.
 */
function mergePolicies(current: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

@Injectable()
export class PropertyService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Brands
  // -------------------------------------------------------------------------
  async createBrand(tenantId: string, dto: CreateBrandDto, actorId: string): Promise<Brand> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Single-brand tenants have exactly one brand (spec §1.1) — the mode is
      // the constraint, not UI behavior.
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      if (tenant.brandMode === 'single') {
        const count = await tx.brand.count({ where: { deletedAt: null } });
        if (count >= 1) {
          throw new ConflictException({
            code: ErrorCode.BRAND_LIMIT_SINGLE_MODE,
            message: 'Single-brand tenants cannot create additional brands',
          });
        }
      }
      const brand = await tx.brand.create({
        data: {
          tenantId,
          name: dto.name,
          logoUrl: dto.logoUrl,
          primaryColor: dto.primaryColor,
          defaultPolicies: dto.defaultPolicies as Prisma.InputJsonValue | undefined,
        },
      });
      await this.audit(tx, tenantId, actorId, 'brand.created', 'brand', brand.id, { name: dto.name });
      return brand;
    });
  }

  async listBrands(tenantId: string): Promise<Brand[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.brand.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    );
  }

  async updateBrand(
    tenantId: string,
    brandId: string,
    dto: UpdateBrandDto,
    actorId: string,
  ): Promise<Brand> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const brand = await tx.brand.findFirst({ where: { id: brandId, deletedAt: null } });
      if (!brand) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Brand not found' });
      }
      const updated = await tx.brand.update({
        where: { id: brandId },
        data: {
          name: dto.name,
          logoUrl: dto.logoUrl,
          primaryColor: dto.primaryColor,
          defaultPolicies: dto.defaultPolicies as Prisma.InputJsonValue | undefined,
        },
      });
      await this.audit(tx, tenantId, actorId, 'brand.updated', 'brand', brandId, dto as Prisma.InputJsonValue);
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Branches
  // -------------------------------------------------------------------------
  async createBranch(
    tenantId: string,
    brandId: string,
    dto: CreateBranchDto,
    actorId: string,
  ): Promise<Branch> {
    assertValidTimezone(dto.timezone);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const brand = await tx.brand.findFirst({ where: { id: brandId, deletedAt: null } });
      if (!brand) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Brand not found' });
      }
      // A second, independent Finish run (a stale/reset local onboarding
      // draft, a different device, a repeated test session) shouldn't be
      // able to silently duplicate a branch — same "pre-check before
      // create, inside the same transaction" pattern `bulkCreateRooms`
      // already uses for `ROOM_NUMBERS_TAKEN`.
      const existing = await tx.branch.findFirst({ where: { brandId, name: dto.name, deletedAt: null } });
      if (existing) {
        throw new ConflictException({
          code: ErrorCode.BRANCH_NAME_TAKEN,
          message: `A branch named "${dto.name}" already exists under this brand`,
        });
      }
      const branch = await tx.branch.create({
        data: {
          tenantId,
          brandId,
          name: dto.name,
          address: dto.address as unknown as Prisma.InputJsonValue,
          timezone: dto.timezone,
          currency: dto.currency,
          ...(dto.checkInTime ? { checkInTime: timeStringToDate(dto.checkInTime) } : {}),
          ...(dto.checkOutTime ? { checkOutTime: timeStringToDate(dto.checkOutTime) } : {}),
          category: dto.category,
          policies: dto.policies as Prisma.InputJsonValue | undefined,
        },
      });
      await this.audit(tx, tenantId, actorId, 'branch.created', 'branch', branch.id, {
        name: dto.name,
        brandId,
      }, branch.id);
      return branch;
    });
  }

  /**
   * Owner-only (see controller): resolves which branch(es) an owner's
   * dashboard should open to. An owner's own role row is always
   * `branchId: null` ("all branches"), so `GET /auth/me/branches`
   * (branches held via an *explicit* per-branch role assignment) always
   * returns `[]` for them by design — this is a deliberately separate
   * endpoint, not a change to that one.
   */
  async listBranches(tenantId: string): Promise<Array<Pick<Branch, 'id' | 'name' | 'timezone'>>> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.branch.findMany({
        where: { deletedAt: null },
        // The timezone too: the web app shows times and "today" on the hotel's clock.
        select: { id: true, name: true, timezone: true },
        orderBy: { name: 'asc' },
      }),
    );
  }

  async updateBranch(
    tenantId: string,
    branchId: string,
    dto: UpdateBranchDto,
    actorId: string,
  ): Promise<Branch> {
    if (dto.timezone) assertValidTimezone(dto.timezone);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.assertBranch(tx, branchId);
      await this.assertCurrencyAndTimezoneUnlocked(tx, branch, dto);
      const updated = await tx.branch.update({
        where: { id: branchId },
        data: {
          name: dto.name,
          address: dto.address as unknown as Prisma.InputJsonValue | undefined,
          timezone: dto.timezone,
          currency: dto.currency,
          ...(dto.checkInTime ? { checkInTime: timeStringToDate(dto.checkInTime) } : {}),
          ...(dto.checkOutTime ? { checkOutTime: timeStringToDate(dto.checkOutTime) } : {}),
          category: dto.category,
          policies: dto.policies === undefined ? undefined : (mergePolicies(branch.policies, dto.policies) as Prisma.InputJsonValue),
        },
      });
      await this.audit(tx, tenantId, actorId, 'branch.updated', 'branch', branchId, dto as Prisma.InputJsonValue, branchId);
      return updated;
    });
  }

  /**
   * Currency and timezone are fixed once the branch has taken a booking or a
   * payment: every stored amount would silently change currency, and every
   * business-day boundary would move under the records already filed.
   */
  private async assertCurrencyAndTimezoneUnlocked(tx: TenantTx, branch: Branch, dto: UpdateBranchDto): Promise<void> {
    const changesCurrency = dto.currency !== undefined && dto.currency !== branch.currency;
    const changesTimezone = dto.timezone !== undefined && dto.timezone !== branch.timezone;
    if (!changesCurrency && !changesTimezone) return;
    const [reservations, payments] = await Promise.all([
      tx.reservation.count({ where: { branchId: branch.id, deletedAt: null } }),
      tx.payment.count({ where: { folio: { branchId: branch.id } } }),
    ]);
    if (reservations > 0 || payments > 0) {
      throw new ConflictException({
        code: ErrorCode.CONFLICT,
        message: `The ${changesCurrency ? 'currency' : 'timezone'} can't be changed once a branch has bookings or payments — contact support if it was set up wrong`,
      });
    }
  }

  /**
   * `GET /branches` (list) is Owner-only and trimmed to `{id, name}` — it
   * exists to resolve an owner's post-login branch picker, not to read a
   * branch's own settings. Property Config needs the FULL row (address,
   * timezone, currency, times, noShowPolicy, regCardTemplate — all plain
   * columns already returned by `assertBranch`'s own unscoped `findFirst`),
   * and a Manager (who can already `updateBranch`) had no way to read it
   * back at all before this.
   */
  async getBranch(tenantId: string, branchId: string): Promise<Branch> {
    return this.prisma.withTenant(tenantId, (tx) => this.assertBranch(tx, branchId));
  }

  async setNoShowPolicy(
    tenantId: string,
    branchId: string,
    dto: NoShowPolicyDto,
    actorId: string,
  ): Promise<Branch> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertBranch(tx, branchId);
      const updated = await tx.branch.update({
        where: { id: branchId },
        data: { noShowPolicy: dto as unknown as Prisma.InputJsonValue },
      });
      await this.audit(tx, tenantId, actorId, 'branch.no_show_policy_updated', 'branch', branchId, dto as Prisma.InputJsonValue, branchId);
      return updated;
    });
  }

  /** `Branch.depositPolicy` — NULL (type `none`) asks no deposit. New bookings pick it up; ones already made keep what they were asked. */
  async setDepositPolicy(tenantId: string, branchId: string, dto: DepositPolicyDto, actorId: string): Promise<Branch> {
    if (dto.type === 'percentage' && (dto.value ?? 0) > 100) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'A deposit can be at most 100% of the stay' });
    }
    const policy = dto.type === 'none' ? null : { type: dto.type, value: dto.type === 'first_night' ? null : (dto.value ?? null), dueDaysBeforeArrival: dto.dueDaysBeforeArrival };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await this.assertBranch(tx, branchId);
      const updated = await tx.branch.update({ where: { id: branchId }, data: { depositPolicy: policy ?? Prisma.JsonNull } });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId,
          userId: actorId,
          action: 'branch.deposit_policy_updated',
          entityType: 'branch',
          entityId: branchId,
          before: before.depositPolicy ?? Prisma.JsonNull,
          after: policy ?? Prisma.JsonNull,
        },
      });
      return updated;
    });
  }

  /** `Branch.dayUsePolicy` — the day-use hours, or NULL when the branch doesn't sell day use. */
  async setDayUsePolicy(tenantId: string, branchId: string, dto: DayUsePolicyDto, actorId: string): Promise<Branch> {
    if (dto.enabled && (!dto.from || !dto.until || dto.until <= dto.from)) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Day use ends after it starts — give a from and an until like 10:00 and 17:00' });
    }
    const policy = dto.enabled ? { from: dto.from, until: dto.until } : null;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await this.assertBranch(tx, branchId);
      const updated = await tx.branch.update({ where: { id: branchId }, data: { dayUsePolicy: policy ?? Prisma.JsonNull } });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId,
          userId: actorId,
          action: 'branch.day_use_policy_updated',
          entityType: 'branch',
          entityId: branchId,
          before: before.dayUsePolicy ?? Prisma.JsonNull,
          after: policy ?? Prisma.JsonNull,
        },
      });
      return updated;
    });
  }

  /** `Branch.turndownPolicy` — the evening turndown: every occupied room, or only VIP guests'. Off: NULL. */
  async setTurndownPolicy(tenantId: string, branchId: string, dto: TurndownPolicyDto, actorId: string): Promise<Branch> {
    if (dto.enabled && !dto.scope) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Say whose rooms are turned down — every occupied room, or VIP guests only' });
    }
    const policy = dto.enabled ? { scope: dto.scope } : null;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await this.assertBranch(tx, branchId);
      const updated = await tx.branch.update({ where: { id: branchId }, data: { turndownPolicy: policy ?? Prisma.JsonNull } });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId,
          userId: actorId,
          action: 'branch.turndown_policy_updated',
          entityType: 'branch',
          entityId: branchId,
          before: before.turndownPolicy ?? Prisma.JsonNull,
          after: policy ?? Prisma.JsonNull,
        },
      });
      return updated;
    });
  }

  /** `Branch.stayFeePolicy` — each half sent replaces what's on file (null switches it off); a half left out stays. */
  async setStayFeePolicy(tenantId: string, branchId: string, dto: StayFeePolicyDto, actorId: string): Promise<Branch> {
    for (const [label, part] of [['A late check-out', dto.lateCheckout], ['An early departure', dto.earlyDeparture]] as const) {
      if (part && 'feeType' in part && part.feeType.startsWith('percent') && (part.amount ?? 0) > 100) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `${label} fee can be at most 100%` });
      }
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await this.assertBranch(tx, branchId);
      const current = (before.stayFeePolicy && typeof before.stayFeePolicy === 'object' && !Array.isArray(before.stayFeePolicy) ? before.stayFeePolicy : {}) as Record<string, unknown>;
      const policy = {
        lateCheckout: dto.lateCheckout === undefined ? (current.lateCheckout ?? null) : dto.lateCheckout ? { ...dto.lateCheckout } : null,
        earlyDeparture:
          dto.earlyDeparture === undefined
            ? (current.earlyDeparture ?? null)
            : dto.earlyDeparture
              ? { feeType: dto.earlyDeparture.feeType, amount: dto.earlyDeparture.feeType === 'first_night' ? null : (dto.earlyDeparture.amount ?? null) }
              : null,
      };
      const off = policy.lateCheckout === null && policy.earlyDeparture === null;
      const updated = await tx.branch.update({ where: { id: branchId }, data: { stayFeePolicy: off ? Prisma.JsonNull : (policy as Prisma.InputJsonValue) } });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId,
          userId: actorId,
          action: 'branch.stay_fee_policy_updated',
          entityType: 'branch',
          entityId: branchId,
          before: before.stayFeePolicy ?? Prisma.JsonNull,
          after: off ? Prisma.JsonNull : (policy as Prisma.InputJsonValue),
        },
      });
      return updated;
    });
  }

  /** `Branch.cancellationPolicy` stays NULL until an owner saves one; NULL means the standard default (reservations/policies.ts). */
  async setCancellationPolicy(
    tenantId: string,
    branchId: string,
    dto: CancellationPolicyDto,
    actorId: string,
  ): Promise<Branch> {
    // A fee amount only means something for a flat-fee policy — don't keep a stale one around.
    const policy = { ...dto, flatFeeAmount: dto.lateCancellationPenalty === 'flat_fee' ? (dto.flatFeeAmount ?? null) : null };
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertBranch(tx, branchId);
      const updated = await tx.branch.update({
        where: { id: branchId },
        data: { cancellationPolicy: policy },
      });
      await this.audit(tx, tenantId, actorId, 'branch.cancellation_policy_updated', 'branch', branchId, policy, branchId);
      return updated;
    });
  }

  /**
   * The privacy notice and booking terms shown on the booking pages. Blank
   * means none: the page then asks nobody to accept anything. A field left
   * out of the request stays as it is.
   */
  async setGuestTerms(tenantId: string, branchId: string, dto: GuestTermsDto, actorId: string): Promise<Branch> {
    const clean = (text: string | null | undefined): string | null | undefined => (text === undefined ? undefined : text?.trim() || null);
    const changes = { privacyNotice: clean(dto.privacyNotice), bookingTerms: clean(dto.bookingTerms) };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await this.assertBranch(tx, branchId);
      const updated = await tx.branch.update({ where: { id: branchId }, data: changes });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId,
          userId: actorId,
          action: 'branch.guest_terms_updated',
          entityType: 'branch',
          entityId: branchId,
          before: { privacyNotice: before.privacyNotice, bookingTerms: before.bookingTerms },
          after: { privacyNotice: updated.privacyNotice, bookingTerms: updated.bookingTerms },
        },
      });
      return updated;
    });
  }

  async setRegCardTemplate(
    tenantId: string,
    branchId: string,
    dto: RegCardTemplateDto,
    actorId: string,
  ): Promise<Branch> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertBranch(tx, branchId);
      const updated = await tx.branch.update({
        where: { id: branchId },
        data: { regCardTemplate: dto as unknown as Prisma.InputJsonValue },
      });
      await this.audit(tx, tenantId, actorId, 'branch.reg_card_template_updated', 'branch', branchId, dto as Prisma.InputJsonValue, branchId);
      return updated;
    });
  }

  /** Read side of `setRegCardTemplate` — lets the edit form pre-fill instead of blind-overwriting fields the caller didn't resubmit. `{}` (not null) when nothing's been set yet, matching the DTO's own all-optional shape. */
  async getRegCardTemplate(tenantId: string, branchId: string): Promise<Prisma.JsonValue> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.assertBranch(tx, branchId);
      return branch.regCardTemplate ?? {};
    });
  }

  // -------------------------------------------------------------------------
  // Buildings & floors (3-mode onboarding: hidden defaults have name NULL)
  // -------------------------------------------------------------------------
  async createBuilding(
    tenantId: string,
    branchId: string,
    dto: CreateBuildingDto,
    actorId: string,
  ): Promise<Building> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertBranch(tx, branchId);
      const building = await tx.building.create({
        data: { tenantId, branchId, name: dto.name },
      });
      await this.audit(tx, tenantId, actorId, 'building.created', 'building', building.id, {
        name: dto.name,
      }, branchId);
      return building;
    });
  }

  async createFloor(
    tenantId: string,
    buildingId: string,
    dto: CreateFloorDto,
    actorId: string,
  ): Promise<Floor> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const building = await tx.building.findFirst({ where: { id: buildingId } });
      if (!building) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Building not found' });
      }
      const floor = await tx.floor.create({
        data: { tenantId, buildingId, floorNumber: dto.floorNumber, label: dto.label },
      });
      await this.audit(tx, tenantId, actorId, 'floor.created', 'floor', floor.id, {
        floorNumber: dto.floorNumber,
      });
      return floor;
    });
  }

  /**
   * Property Config's Rooms & Layout: every building and floor at the branch,
   * empty ones too, with how many rooms each floor has — the rooms list only
   * ever shows a floor that has a room on it.
   */
  async getLayout(tenantId: string, branchId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertBranch(tx, branchId);
      return tx.building.findMany({
        where: { branchId },
        include: {
          floors: {
            include: { _count: { select: { rooms: { where: { deletedAt: null } } } } },
            orderBy: [{ floorNumber: 'asc' }, { createdAt: 'asc' }],
          },
        },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  /** Names a building — the hidden default one ("Rooms Only" onboarding) too, which then shows by that name. */
  async renameBuilding(tenantId: string, buildingId: string, name: string, actorId: string): Promise<Building> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const building = await tx.building.findFirst({ where: { id: buildingId } });
      if (!building) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Building not found' });
      const updated = await tx.building.update({ where: { id: buildingId }, data: { name: name.trim() } });
      await this.audit(tx, tenantId, actorId, 'building.renamed', 'building', buildingId, { from: building.name, to: updated.name }, building.branchId);
      return updated;
    });
  }

  async updateFloor(tenantId: string, floorId: string, dto: { floorNumber?: number; label?: string }, actorId: string): Promise<Floor> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const floor = await tx.floor.findFirst({ where: { id: floorId } });
      if (!floor) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Floor not found' });
      const data: Prisma.FloorUpdateInput = {};
      if (dto.floorNumber !== undefined) data.floorNumber = dto.floorNumber;
      if (dto.label !== undefined) data.label = dto.label.trim() || null;
      const updated = await tx.floor.update({ where: { id: floorId }, data });
      await this.audit(tx, tenantId, actorId, 'floor.updated', 'floor', floorId, {
        ...(dto.floorNumber !== undefined ? { floorNumber: { from: floor.floorNumber, to: updated.floorNumber } } : {}),
        ...(dto.label !== undefined ? { label: { from: floor.label, to: updated.label } } : {}),
      });
      return updated;
    });
  }

  /**
   * "Floors Only" onboarding: floors without explicit buildings hang off the
   * branch's hidden default building (auto-created, name NULL — spec §1.1).
   */
  async createBranchFloor(
    tenantId: string,
    branchId: string,
    dto: CreateFloorDto,
    actorId: string,
  ): Promise<Floor> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertBranch(tx, branchId);
      const building = await this.findOrCreateDefaultBuilding(tx, tenantId, branchId);
      const floor = await tx.floor.create({
        data: { tenantId, buildingId: building.id, floorNumber: dto.floorNumber, label: dto.label },
      });
      await this.audit(tx, tenantId, actorId, 'floor.created', 'floor', floor.id, {
        floorNumber: dto.floorNumber,
        defaultBuilding: true,
      });
      return floor;
    });
  }

  /** Shared with RoomsService ("Rooms Only" mode). */
  async findOrCreateDefaultBuilding(
    tx: TenantTx,
    tenantId: string,
    branchId: string,
  ): Promise<Building> {
    const existing = await tx.building.findFirst({ where: { branchId, name: null } });
    if (existing) return existing;
    return tx.building.create({ data: { tenantId, branchId, name: null } });
  }

  async findOrCreateDefaultFloor(
    tx: TenantTx,
    tenantId: string,
    branchId: string,
  ): Promise<Floor> {
    const building = await this.findOrCreateDefaultBuilding(tx, tenantId, branchId);
    const existing = await tx.floor.findFirst({
      where: { buildingId: building.id, label: null },
    });
    if (existing) return existing;
    return tx.floor.create({
      data: { tenantId, buildingId: building.id, floorNumber: 0, label: null },
    });
  }

  // -------------------------------------------------------------------------
  // Overbooking config
  // -------------------------------------------------------------------------
  async updateOverbookingConfig(
    tenantId: string,
    branchId: string,
    dto: UpdateOverbookingConfigDto,
    actorId: string,
  ): Promise<OverbookingConfig> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertBranch(tx, branchId);
      // This branch's own room type — any id in the organisation used to be taken.
      if (dto.roomTypeId) {
        const roomType = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, branchId, deletedAt: null }, select: { id: true } });
        if (!roomType) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found at this branch' });
      }
      const data = {
        globalEnabled: dto.globalEnabled,
        maxOverbookPct: dto.maxOverbookPct,
        alertAtPct: dto.alertAtPct,
        // `null` clears a date; leaving it out keeps it.
        validFrom: dto.validFrom === null ? null : dto.validFrom ? new Date(dto.validFrom) : undefined,
        validTo: dto.validTo === null ? null : dto.validTo ? new Date(dto.validTo) : undefined,
        updatedBy: actorId,
      };
      // NULL roomTypeId rows aren't caught by the unique constraint (NULLs are
      // distinct in PG) — find-then-write instead of upsert.
      const existing = await tx.overbookingConfig.findFirst({
        where: { branchId, roomTypeId: dto.roomTypeId ?? null },
      });
      const config = existing
        ? await tx.overbookingConfig.update({ where: { id: existing.id }, data })
        : await tx.overbookingConfig.create({
            data: { tenantId, branchId, roomTypeId: dto.roomTypeId ?? null, ...data },
          });
      await this.audit(tx, tenantId, actorId, 'branch.overbooking_config_updated', 'overbooking_config', config.id, dto as Prisma.InputJsonValue, branchId);
      return config;
    });
  }

  /** The `PATCH` above upserts blind — nothing previously read a branch's current config back, e.g. to show what's already configured before changing it. */
  async listOverbookingConfigs(tenantId: string, branchId: string): Promise<OverbookingConfig[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertBranch(tx, branchId);
      return tx.overbookingConfig.findMany({ where: { branchId }, orderBy: { roomTypeId: { sort: 'asc', nulls: 'first' } } });
    });
  }

  // -------------------------------------------------------------------------
  async assertBranch(tx: TenantTx, branchId: string): Promise<Branch> {
    const branch = await tx.branch.findFirst({ where: { id: branchId, deletedAt: null } });
    if (!branch) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Branch not found' });
    }
    return branch;
  }

  private async audit(
    tx: TenantTx,
    tenantId: string,
    userId: string,
    action: string,
    entityType: string,
    entityId: string,
    after?: Prisma.InputJsonValue,
    /** The branch it happened at — what the audit-log viewer scopes a branch manager by. NULL for the brand and the organisation. */
    branchId?: string | null,
  ): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, branchId: branchId ?? null, userId, action, entityType, entityId, after } });
  }
}
