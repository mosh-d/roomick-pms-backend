import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RatePlan, RateType, RoomType } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { TaxesService } from '../taxes/taxes.service';
import { CalculateRateDto, CreateRatePlanDto, UpdateRatePlanDto } from './dto/rate-resolver.dto';

/** Sunday = 0 … Saturday = 6 (`Date.getUTCDay`). A night is named by the date it starts on, so Friday and Saturday nights are the weekend unless the branch says otherwise. */
export const DEFAULT_WEEKEND_NIGHTS: readonly number[] = [5, 6];

/** The branch's own weekend nights — `Branch.policies.weekendNights`, an array of weekday numbers 0–6 — or the default. */
export function weekendNightsFor(policies: Prisma.JsonValue | null | undefined): number[] {
  const raw = policies && typeof policies === 'object' && !Array.isArray(policies) ? (policies as Record<string, unknown>).weekendNights : undefined;
  if (Array.isArray(raw)) {
    const days = raw.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6);
    if (days.length > 0) return [...new Set(days)];
  }
  return [...DEFAULT_WEEKEND_NIGHTS];
}

/** Matches the schema's own comment on `RatePlan.cascadeTier` — the tier is derived from `type`, never client-supplied. */
const CASCADE_TIER_BY_TYPE: Partial<Record<RateType, number>> = { base: 1, seasonal: 2, weekend: 3, corporate: 4 };
const OVERRIDE_TYPES: RateType[] = ['negotiated', 'promotional'];

export interface CascadeStep {
  tier: number;
  ratePlanId: string;
  ratePlanName: string;
  adjustmentType: string;
  amountBefore: string;
  adjustment: string;
  amountAfter: string;
}

interface NightResolution {
  date: string;
  finalRate: Prisma.Decimal;
  isOverride: boolean;
  overrideRatePlanId: string | null;
  overrideRatePlanName: string | null;
  cascade: CascadeStep[];
}

export interface StayResolution {
  nightlyRate: Prisma.Decimal;
  /** The room price for the stay: the nightly rates added up. What `confirmedRate` stores. */
  subtotal: Prisma.Decimal;
  /** Tax added on top of `subtotal`. */
  taxTotal: Prisma.Decimal;
  /** Tax already inside `subtotal` — a branch quoting tax-inclusive rates. Shown, never added again. */
  taxIncluded: Prisma.Decimal;
  /** What the guest pays: `subtotal` + `taxTotal`. */
  totalWithTax: Prisma.Decimal;
  /** The check-in night's winning plan — display/reporting convenience only. A stay whose rate changes mid-week (seasonal/weekend tiers) has no single "the" plan; the full per-night trace is what's authoritative, both here and in RateAuditLog. */
  ratePlanId: string | null;
  ruleApplied: { type: 'override' | 'cascade' | 'base'; planName: string | null; adjustmentApplied: string | null };
  perNight: Array<{ date: string; finalRate: string; isOverride: boolean; ratePlanId: string | null }>;
  /** RateAuditLog rows this resolution wrote, `reservationId: null` if none was passed in — pass to `linkAuditLogsToReservation` once the reservation exists. */
  auditLogIds: bigint[];
}

export type TriggeredBy = 'checkin' | 'booking_create' | 'override' | 'ota_import' | 'walkin' | 'modify' | 'extend_stay' | 'room_move';

@Injectable()
export class RateResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    private readonly taxesService: TaxesService,
  ) {}

  // -------------------------------------------------------------------------
  // Rate plan CRUD
  // -------------------------------------------------------------------------
  async createRatePlan(tenantId: string, branchId: string, dto: CreateRatePlanDto): Promise<RatePlan> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      if (dto.roomTypeId) {
        const roomType = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, branchId, deletedAt: null } });
        if (!roomType) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found at this branch' });
      }
      const isOverride = OVERRIDE_TYPES.includes(dto.type);
      if (isOverride && dto.adjustmentType) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `adjustmentType must be omitted for "${dto.type}" — its amount is an absolute nightly rate, not a delta` });
      }
      if (!isOverride && !dto.adjustmentType) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `adjustmentType is required for "${dto.type}"` });
      }
      if (dto.type === 'promotional' && !dto.promoCode) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'promoCode is required for a promotional plan' });
      }
      return tx.ratePlan.create({
        data: {
          tenantId,
          branchId,
          roomTypeId: dto.roomTypeId ?? null,
          name: dto.name,
          type: dto.type,
          amount: new Prisma.Decimal(dto.amount),
          adjustmentType: isOverride ? null : (dto.adjustmentType ?? null),
          cascadeTier: CASCADE_TIER_BY_TYPE[dto.type] ?? 0,
          isOverride,
          validFrom: dto.validFrom ? new Date(dto.validFrom) : null,
          validTo: dto.validTo ? new Date(dto.validTo) : null,
          minLOS: dto.minLOS ?? null,
          promoCode: dto.type === 'promotional' ? dto.promoCode : null,
        },
      });
    });
  }

  async listRatePlans(tenantId: string, branchId: string): Promise<RatePlan[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      return tx.ratePlan.findMany({ where: { branchId }, orderBy: [{ cascadeTier: 'asc' }, { name: 'asc' }] });
    });
  }

  /** Retires/reinstates a plan. Never deletes — a deleted plan would orphan `ratePlanId` on every reservation and RateAuditLog row that resolved through it. */
  async updateRatePlan(tenantId: string, ratePlanId: string, dto: UpdateRatePlanDto): Promise<RatePlan> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const plan = await tx.ratePlan.findFirst({ where: { id: ratePlanId } });
      if (!plan) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Rate plan not found' });
      return tx.ratePlan.update({ where: { id: ratePlanId }, data: { ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}) } });
    });
  }

  // -------------------------------------------------------------------------
  // Pre-booking quote endpoint
  // -------------------------------------------------------------------------
  /**
   * `userId: null` + `persistAudit: false` is the Direct Booking Engine's
   * public quote path — an anonymous guest browsing dates has no user row to
   * attribute, and `RateAuditLog.userId` is already nullable ("NULL =
   * automated"). Staff callers pass their own id and persist as before.
   */
  async calculateQuote(
    tenantId: string,
    branchId: string,
    dto: CalculateRateDto,
    userId: string | null,
    options: { persistAudit?: boolean } = {},
  ): Promise<Omit<StayResolution, 'auditLogIds'>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const roomType = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, branchId, deletedAt: null } });
      if (!roomType) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found at this branch' });
      const checkInDate = toBranchDate(dto.checkInDate);
      const checkOutDate = toBranchDate(dto.checkOutDate);
      if (checkOutDate <= checkInDate) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'checkOutDate must be after checkInDate' });
      }
      // `auditLogIds` is a bigint[] — internal plumbing for
      // `ReservationsService` to link a resolution to the reservation it
      // eventually creates (see `resolveStay`'s own comment). A pure quote
      // never creates a reservation, and `bigint` doesn't survive
      // `JSON.stringify` (the exact crash `getAuditTrail` had before its
      // own fix) — strip it before this crosses the HTTP boundary.
      const { auditLogIds: _auditLogIds, ...resolution } = await this.resolveStay(
        tx,
        tenantId,
        branchId,
        roomType,
        checkInDate,
        checkOutDate,
        { promoCode: dto.promoCode, corporateAccountId: dto.corporateAccountId },
        { triggeredBy: 'booking_create', userId: userId ?? undefined, persistAudit: options.persistAudit },
      );
      return resolution;
    });
  }

  async getAuditTrail(tenantId: string, reservationId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.rateAuditLog.findMany({ where: { reservationId }, orderBy: { resolvedAt: 'asc' } });
      // `id` is a BigInt (append-only log, same convention as
      // `NightAuditLog`) — JSON.stringify would throw on it.
      return rows.map((r) => ({ ...r, id: r.id.toString() }));
    });
  }

  // -------------------------------------------------------------------------
  // Core resolver — called by ReservationsService with an already-fetched
  // RoomType, so it never re-queries what the caller already validated.
  // -------------------------------------------------------------------------
  async resolveStay(
    tx: TenantTx,
    tenantId: string,
    branchId: string,
    roomType: RoomType,
    checkInDate: Date,
    checkOutDate: Date,
    options: { promoCode?: string; corporateAccountId?: string },
    context: { triggeredBy: TriggeredBy; userId?: string; reservationId?: string; persistAudit?: boolean },
  ): Promise<StayResolution> {
    const nights = this.enumerateNights(checkInDate, checkOutDate);
    const stayLength = nights.length;

    let corporateRatePlanId: string | null = null;
    let isCorporate = false;
    if (options.corporateAccountId) {
      const account = await tx.corporateAccount.findFirst({ where: { id: options.corporateAccountId, isActive: true } });
      corporateRatePlanId = account?.ratePlanId ?? null;
      isCorporate = account !== null;
    }

    const plans = await tx.ratePlan.findMany({
      where: {
        branchId,
        isActive: true,
        AND: [
          { OR: [{ roomTypeId: roomType.id }, { roomTypeId: null }] },
          { OR: [{ validFrom: null }, { validFrom: { lte: checkOutDate } }] },
          { OR: [{ validTo: null }, { validTo: { gte: checkInDate } }] },
          { OR: [{ minLOS: null }, { minLOS: { lte: stayLength } }] },
        ],
      },
    });

    // A `corporate` cascade plan is a discount for company bookings — it used
    // to apply to every booking alike, since nothing could be booked for a
    // company before accounts existed. Now only a stay booked under an active
    // company account gets it.
    const eligible = isCorporate ? plans : plans.filter((plan) => plan.type !== 'corporate');
    const branch = await tx.branch.findFirst({ where: { id: branchId }, select: { policies: true } });
    const weekendNights = weekendNightsFor(branch?.policies);
    const perNight: NightResolution[] = nights.map((date) => this.resolveNight(roomType, date, eligible, options.promoCode, corporateRatePlanId, weekendNights));

    // `create`, not `createMany` — a booking-create/walk-in call resolves
    // the rate BEFORE the reservation row exists, so `reservationId` is
    // NULL here by necessity (the schema's own comment anticipates this:
    // "NULL during pre-booking calculation"). But that would leave the
    // audit trail for the exact calculation that actually set the price —
    // the one a real dispute needs — permanently unlinkable, which defeats
    // the endpoint's own purpose. So these ids are returned and the caller
    // (`ReservationsService`) backfills `reservationId` on them the moment
    // the reservation exists (see `createReservation`/`walkIn`). Only
    // `create` returns the row back with its id; `createMany` doesn't.
    // `persistAudit: false` is the Direct Booking Engine's public quote path
    // ONLY. That endpoint is unauthenticated and re-quotes on every date or
    // room-type change a browsing guest makes, so persisting here would write
    // one row PER NIGHT per keystroke-level interaction — unbounded write
    // amplification driven by anonymous traffic. A quote nobody booked has no
    // dispute to defend, which is what this trail exists for; the moment that
    // same guest actually books, `createReservation` resolves again through
    // the ordinary path and DOES persist and link the trail. Defaults to
    // true, so every existing caller is unchanged.
    const auditLogIds: bigint[] = [];
    for (const n of context.persistAudit === false ? [] : perNight) {
      const row = await tx.rateAuditLog.create({
        data: {
          tenantId,
          branchId,
          reservationId: context.reservationId ?? null,
          input: {
            roomTypeId: roomType.id,
            date: n.date,
            promoCode: options.promoCode ?? null,
            corporateAccountId: options.corporateAccountId ?? null,
          },
          result: {
            finalRate: n.finalRate.toFixed(2),
            isOverride: n.isOverride,
            overrideRatePlanId: n.overrideRatePlanId,
            cascade: n.cascade,
          } as unknown as Prisma.InputJsonValue,
          triggeredBy: context.triggeredBy,
          userId: context.userId ?? null,
        },
        select: { id: true },
      });
      auditLogIds.push(row.id);
    }

    const subtotal = perNight.reduce((sum, n) => sum.add(n.finalRate), new Prisma.Decimal(0));
    const nightlyRate = stayLength ? subtotal.div(stayLength).toDecimalPlaces(2) : new Prisma.Decimal(0);
    // One room charge per night, so a fixed tax counts once per night — what the nights will actually post.
    const priced = await this.taxesService.priceCharge(tx, branchId, 'room', subtotal, perNight.length);

    const arrival = perNight[0];
    const lastCascadeStep = arrival?.cascade.at(-1) ?? null;

    return {
      nightlyRate,
      subtotal,
      taxTotal: priced.addedTax,
      taxIncluded: priced.includedTax,
      totalWithTax: priced.total,
      ratePlanId: arrival ? (arrival.overrideRatePlanId ?? lastCascadeStep?.ratePlanId ?? null) : null,
      ruleApplied: {
        type: !arrival ? 'base' : arrival.isOverride ? 'override' : lastCascadeStep ? 'cascade' : 'base',
        planName: arrival ? (arrival.overrideRatePlanName ?? lastCascadeStep?.ratePlanName ?? null) : null,
        adjustmentApplied: lastCascadeStep?.adjustment ?? null,
      },
      perNight: perNight.map((n) => ({ date: n.date, finalRate: n.finalRate.toFixed(2), isOverride: n.isOverride, ratePlanId: n.overrideRatePlanId ?? n.cascade.at(-1)?.ratePlanId ?? null })),
      auditLogIds,
    };
  }

  /** See `resolveStay`'s own comment on `auditLogIds` — call this the moment a reservation created FROM a resolution that had no id yet gets one. A no-op for an empty array (e.g. a pure quote with no reservation ever created). */
  async linkAuditLogsToReservation(tx: TenantTx, auditLogIds: bigint[], reservationId: string): Promise<void> {
    if (!auditLogIds.length) return;
    await tx.rateAuditLog.updateMany({ where: { id: { in: auditLogIds } }, data: { reservationId } });
  }

  /**
   * Override precedence: negotiated beats promotional. The reference
   * timeline's prose priority list ("manual override → corporate → promo →
   * negotiated → ...") reads as if promo outranks negotiated, but its
   * "corporate" tier has no schema counterpart of its own — `RatePlan.type
   * = corporate` is a cascade tier, not an override, and the only place a
   * corporate account's rate lives is `CorporateAccount.ratePlanId`,
   * pointing at a `type: negotiated` plan. Read that way the two lists
   * agree: a caller's corporate account (→ negotiated plan) outranks a
   * generic typed-in promo code, matching how an actual negotiated
   * contract rate should never be undercut by a public promo.
   */
  private resolveNight(roomType: RoomType, date: Date, plans: RatePlan[], promoCode: string | undefined, corporateRatePlanId: string | null, weekendNights: number[]): NightResolution {
    const applicable = plans
      .filter((p) => p.validFrom === null || p.validFrom <= date)
      .filter((p) => p.validTo === null || p.validTo >= date)
      // A weekend plan is for weekend nights. It used to apply to every night
      // inside its date window — a "+15% weekends" uplift charged Monday too.
      .filter((p) => p.type !== 'weekend' || weekendNights.includes(date.getUTCDay()));
    const overridePlans = applicable.filter((p) => p.isOverride);

    const negotiated = corporateRatePlanId ? overridePlans.find((p) => p.type === 'negotiated' && p.id === corporateRatePlanId) : undefined;
    const promotional = promoCode ? overridePlans.find((p) => p.type === 'promotional' && p.promoCode === promoCode) : undefined;
    const winner = negotiated ?? promotional;

    const dateKey = date.toISOString().slice(0, 10);

    if (winner) {
      return {
        date: dateKey,
        finalRate: winner.amount,
        isOverride: true,
        overrideRatePlanId: winner.id,
        overrideRatePlanName: winner.name,
        cascade: [],
      };
    }

    const cascadePlans = applicable.filter((p) => !p.isOverride);
    // One plan per tier — a data-hygiene edge case (two active "weekend"
    // plans with overlapping windows) shouldn't double-apply. Prefer a
    // room-type-specific plan over a branch-wide one, then the most
    // recently created.
    const byTier = new Map<number, RatePlan>();
    for (const plan of cascadePlans) {
      const existing = byTier.get(plan.cascadeTier);
      if (!existing) {
        byTier.set(plan.cascadeTier, plan);
        continue;
      }
      const planIsMoreSpecific = plan.roomTypeId !== null && existing.roomTypeId === null;
      const equallySpecificButNewer = (plan.roomTypeId !== null) === (existing.roomTypeId !== null) && plan.createdAt > existing.createdAt;
      if (planIsMoreSpecific || equallySpecificButNewer) byTier.set(plan.cascadeTier, plan);
    }
    const applied = [...byTier.values()].sort((a, b) => a.cascadeTier - b.cascadeTier);

    let running = roomType.baseRate;
    const cascade: CascadeStep[] = [];
    for (const plan of applied) {
      const before = running;
      const adjustment = plan.adjustmentType === 'percentage' ? before.mul(plan.amount).div(100).toDecimalPlaces(2) : plan.amount;
      running = before.add(adjustment).toDecimalPlaces(2);
      cascade.push({
        tier: plan.cascadeTier,
        ratePlanId: plan.id,
        ratePlanName: plan.name,
        adjustmentType: plan.adjustmentType ?? 'fixed',
        amountBefore: before.toFixed(2),
        adjustment: adjustment.toFixed(2),
        amountAfter: running.toFixed(2),
      });
    }

    return { date: dateKey, finalRate: running, isOverride: false, overrideRatePlanId: null, overrideRatePlanName: null, cascade };
  }

  private enumerateNights(from: Date, to: Date): Date[] {
    const nights: Date[] = [];
    for (let d = new Date(from); d < to; d.setUTCDate(d.getUTCDate() + 1)) {
      nights.push(new Date(d));
    }
    return nights;
  }
}
