import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Competitor, Prisma } from '@prisma/client';
import { SystemRole } from '../../common/decorators/roles.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { assertRoleAtBranch } from '../../common/utils/branch-roles';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { RateResolverService } from '../rate-resolver/rate-resolver.service';
import { CompSetQueryDto, SetCompetitorRatesDto, UpdateCompetitorDto } from './dto/revenue-management.dto';

const DEFAULT_DAYS = 14;
const DEFAULT_THRESHOLD_PCT = 10;
const MAX_RATE_RUN_DAYS = 92;
const MANAGER_ROLES = [SystemRole.Owner, SystemRole.Manager];

/**
 * - `above_market` — our rate is more than the threshold above the comp set's median.
 * - `below_market` — more than the threshold below it.
 * - `in_line` — within the threshold.
 * - `no_data` — no competitor rate entered for the night.
 */
export type MarketPosition = 'above_market' | 'in_line' | 'below_market' | 'no_data';

export interface MarketComparison {
  marketMedian: string | null;
  marketLow: string | null;
  marketHigh: string | null;
  /** Our rate against the market median, in percent: positive = dearer. */
  diffPct: number | null;
  position: MarketPosition;
  /** 1 = cheapest, among our rate and every competitor rate entered for the night. */
  rank: number | null;
  ofTotal: number | null;
}

export interface CompSetDay extends MarketComparison {
  date: string;
  ourRate: string;
  competitorRates: Array<{ competitorId: string; rate: string | null }>;
}

export interface CompSetAnalysis {
  currency: string;
  roomTypeId: string;
  roomTypeName: string;
  thresholdPct: number;
  competitors: Array<{ id: string; name: string }>;
  days: CompSetDay[];
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Where our rate sits against the competitors' — pure, so the rule can be
 * tested on its own. The median, not the mean: one competitor's
 * conference-week price shouldn't drag the whole market with it.
 */
export function compareToMarket(ourRate: Prisma.Decimal, marketRates: Prisma.Decimal[], thresholdPct: number): MarketComparison {
  if (marketRates.length === 0) {
    return { marketMedian: null, marketLow: null, marketHigh: null, diffPct: null, position: 'no_data', rank: null, ofTotal: null };
  }
  const sorted = [...marketRates].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : sorted[mid - 1].plus(sorted[mid]).div(2);
  const diffPct = median.isZero() ? null : ourRate.minus(median).div(median).mul(100).toDecimalPlaces(1).toNumber();

  let position: MarketPosition = 'in_line';
  if (diffPct !== null && diffPct > thresholdPct) position = 'above_market';
  else if (diffPct !== null && diffPct < -thresholdPct) position = 'below_market';

  return {
    marketMedian: median.toDecimalPlaces(2).toFixed(2),
    marketLow: sorted[0].toFixed(2),
    marketHigh: sorted[sorted.length - 1].toFixed(2),
    diffPct,
    position,
    rank: 1 + sorted.filter((rate) => rate.lessThan(ourRate)).length,
    ofTotal: sorted.length + 1,
  };
}

/**
 * Revenue Management's "Comp Set Analysis" (ref: "competitor rates, parity
 * alerts, position indicator, manual comp entry"). Competitor rates are
 * entered by hand — the plan's own Month 8 call; a paid rate-shopping feed
 * would write the same `competitor_rates` rows later, behind the same read.
 *
 * "Our rate" is what the Rate Resolver quotes a one-night direct booking for
 * that night — the figure the booking engine shows a guest, through the one
 * pricing path, not a second copy of it.
 */
@Injectable()
export class CompSetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    private readonly rateResolverService: RateResolverService,
  ) {}

  async listCompetitors(tenantId: string, branchId: string): Promise<Competitor[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      return tx.competitor.findMany({ where: { branchId }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
    });
  }

  async createCompetitor(tenantId: string, branchId: string, name: string, actorId: string): Promise<Competitor> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const trimmed = this.requireName(name);
      await this.assertNameFree(tx, branchId, trimmed);
      const competitor = await tx.competitor.create({ data: { tenantId, branchId, name: trimmed } });
      await this.audit(tx, tenantId, branchId, actorId, 'competitor.created', competitor.id, { name: trimmed });
      return competitor;
    });
  }

  async updateCompetitor(tenantId: string, competitorId: string, dto: UpdateCompetitorDto, actor: JwtPayload): Promise<Competitor> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const competitor = await tx.competitor.findFirst({ where: { id: competitorId } });
      if (!competitor) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Competitor not found' });
      assertRoleAtBranch(actor, competitor.branchId, MANAGER_ROLES);
      const name = dto.name === undefined ? undefined : this.requireName(dto.name);
      if (name !== undefined) await this.assertNameFree(tx, competitor.branchId, name, competitor.id);
      const updated = await tx.competitor.update({ where: { id: competitorId }, data: { name, isActive: dto.isActive } });
      await this.audit(tx, tenantId, competitor.branchId, actor.sub, 'competitor.updated', competitorId, { name: updated.name, isActive: updated.isActive });
      return updated;
    });
  }

  /** One rate across a run of nights, or clears them. Re-entering a night replaces what was there. */
  async setRates(tenantId: string, branchId: string, dto: SetCompetitorRatesDto, actorId: string): Promise<{ nights: number }> {
    const from = toBranchDate(dto.fromDate);
    const through = toBranchDate(dto.throughDate);
    if (through < from) throw this.invalid('The last night must be on or after the first');
    const nights = Math.round((through.getTime() - from.getTime()) / 86_400_000) + 1;
    if (nights > MAX_RATE_RUN_DAYS) throw this.invalid(`Enter at most ${MAX_RATE_RUN_DAYS} nights at a time`);
    if (!dto.clear && dto.rate === undefined) throw this.invalid('Give a rate, or choose to clear these nights');

    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const competitor = await tx.competitor.findFirst({ where: { id: dto.competitorId, branchId } });
      if (!competitor) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Competitor not found at this branch' });
      const roomType = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, branchId, deletedAt: null } });
      if (!roomType) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found at this branch' });

      if (dto.clear) {
        await tx.competitorRate.deleteMany({ where: { competitorId: competitor.id, roomTypeId: roomType.id, stayDate: { gte: from, lte: through } } });
      } else {
        const rate = new Prisma.Decimal(dto.rate ?? 0);
        for (let i = 0; i < nights; i++) {
          const stayDate = addDays(from, i);
          await tx.competitorRate.upsert({
            where: { competitorId_roomTypeId_stayDate: { competitorId: competitor.id, roomTypeId: roomType.id, stayDate } },
            create: { tenantId, competitorId: competitor.id, roomTypeId: roomType.id, stayDate, rate, enteredBy: actorId },
            update: { rate, enteredBy: actorId },
          });
        }
      }
      await this.audit(tx, tenantId, branchId, actorId, dto.clear ? 'competitor_rates.cleared' : 'competitor_rates.set', competitor.id, {
        roomTypeId: roomType.id,
        fromDate: dto.fromDate,
        throughDate: dto.throughDate,
        rate: dto.clear ? null : new Prisma.Decimal(dto.rate ?? 0).toFixed(2),
      });
      return { nights };
    });
  }

  async getCompSet(tenantId: string, branchId: string, query: CompSetQueryDto): Promise<CompSetAnalysis> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const roomType = await tx.roomType.findFirst({ where: { id: query.roomTypeId, branchId, deletedAt: null } });
      if (!roomType) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found at this branch' });

      const from = toBranchDate(query.from ?? todayInTimezone(branch.timezone));
      const days = query.days ?? DEFAULT_DAYS;
      const thresholdPct = query.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
      const to = addDays(from, days);

      const competitors = await tx.competitor.findMany({ where: { branchId, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
      const rates =
        competitors.length > 0
          ? await tx.competitorRate.findMany({
              where: { competitorId: { in: competitors.map((c) => c.id) }, roomTypeId: roomType.id, stayDate: { gte: from, lt: to } },
              select: { competitorId: true, stayDate: true, rate: true },
            })
          : [];
      const rateByNight = new Map(rates.map((r) => [`${r.competitorId}|${isoDate(r.stayDate)}`, r.rate]));

      const result: CompSetDay[] = [];
      for (let i = 0; i < days; i++) {
        const night = addDays(from, i);
        const date = isoDate(night);
        const quote = await this.rateResolverService.resolveStay(tx, tenantId, branchId, roomType, night, addDays(night, 1), {}, {
          triggeredBy: 'booking_create',
          persistAudit: false,
        });
        const ourRate = new Prisma.Decimal(quote.perNight[0]?.finalRate ?? quote.subtotal);
        const competitorRates = competitors.map((c) => ({ competitorId: c.id, rate: rateByNight.get(`${c.id}|${date}`) ?? null }));
        const market = competitorRates.flatMap((r) => (r.rate ? [r.rate] : []));
        result.push({
          date,
          ourRate: ourRate.toFixed(2),
          competitorRates: competitorRates.map((r) => ({ competitorId: r.competitorId, rate: r.rate ? r.rate.toFixed(2) : null })),
          ...compareToMarket(ourRate, market, thresholdPct),
        });
      }

      return { currency: branch.currency, roomTypeId: roomType.id, roomTypeName: roomType.name, thresholdPct, competitors, days: result };
    });
  }

  // -------------------------------------------------------------------------

  private invalid(message: string): BadRequestException {
    return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
  }

  private requireName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw this.invalid("The competitor's name can't be blank");
    return trimmed;
  }

  private async assertNameFree(tx: TenantTx, branchId: string, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.competitor.findFirst({
      where: { branchId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) throw new ConflictException({ code: ErrorCode.CONFLICT, message: `"${name}" is already in the comp set` });
  }

  private async audit(
    tx: TenantTx,
    tenantId: string,
    branchId: string,
    userId: string,
    action: string,
    entityId: string,
    after?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, branchId, userId, action, entityType: 'competitor', entityId, after } });
  }
}
