import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { GuestProfile, LoyaltyProgram, LoyaltyTxType, Prisma, Reservation } from '@prisma/client';
import { SystemRole } from '../../common/decorators/roles.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { assertRoleAtBranch } from '../../common/utils/branch-roles';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CommsLogService } from '../comms-log/comms-log.service';
import { FoliosService } from '../folios/folios.service';
import { AdjustPointsDto, SaveLoyaltyProgramDto } from './dto/loyalty.dto';
import { applyLoyaltyPoints, findLoyaltyGuest, LIFETIME_POINTS_WHERE, lifetimeLoyaltyPoints, LoyaltyEntry, lockLoyaltyGuest } from './loyalty-ledger';
import { lapsedPoints, LoyaltyTier, SUGGESTED_TIERS, nextTierFor, parseTiers, pointsExpireAt, pointsForSpend, redemptionValue, sortTiers, tierFor } from './loyalty-rules';

const REDEEM_ROLES = [SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk];
const HISTORY_ROWS = 50;

export interface LoyaltyMember {
  id: string;
  name: string;
  email: string | null;
  loyaltyTier: string;
  loyaltyPoints: number;
}

export interface LoyaltyTierSummary {
  tier: string;
  memberCount: number;
  totalPoints: number;
}

export interface LoyaltySummary {
  members: LoyaltyMember[];
  byTier: LoyaltyTierSummary[];
  totalMembers: number;
  totalPointsIssued: number;
}

export interface LoyaltyProgramView {
  /** false until a programme has been saved — the figures shown are then only a suggestion. */
  configured: boolean;
  isActive: boolean;
  currency: string;
  pointsPerUnit: string;
  pointValue: string;
  tiers: LoyaltyTier[];
  /** Points earned lapse this many months later if unspent; null = never. */
  pointsExpireAfterMonths: number | null;
  /** The currencies the tenant's branches charge in — the programme's must be one of them. */
  branchCurrencies: string[];
  updatedAt: Date | null;
}

export interface GuestLoyaltyView {
  guestId: string;
  programActive: boolean;
  currency: string | null;
  pointValue: string | null;
  enrolledAt: Date | null;
  balance: number;
  lifetimePoints: number;
  /** The programme tier reached. `tierName` is what the profile says, which can be a tier typed in before the programme existed. */
  tier: LoyaltyTier | null;
  tierName: string | null;
  nextTier: { name: string; pointsToGo: number } | null;
  /** What the whole balance is worth at redemption. */
  redeemableValue: string | null;
  /** The next points to lapse unspent, and when — null when none are due to. */
  expiring: { points: number; on: Date } | null;
  transactions: Array<{ id: string; type: LoyaltyTxType; points: number; description: string; createdAt: Date }>;
}

export interface RedemptionResult {
  paymentId: string;
  pointsRedeemed: number;
  amount: string;
  currency: string;
  balance: number;
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

function conflict(message: string): ConflictException {
  return new ConflictException({ code: ErrorCode.CONFLICT, message });
}

/**
 * Loyalty (growth plan Month 11). Points are an append-only ledger
 * (`loyalty_transactions`); `GuestProfile.loyaltyPoints` is the balance, kept
 * in the same transaction as every row. A member earns once per stay, at
 * check-out, on the stay's spend before tax — corrections included, so a
 * reversed charge earns nothing. Their tier is the highest one their lifetime
 * points have reached, upgraded the moment they reach it. Redeeming turns
 * points into a `loyalty_points` payment on the guest's bill, never worth
 * more than the bill still owes, so points can never become cash back.
 */
@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foliosService: FoliosService,
    private readonly commsLogService: CommsLogService,
  ) {}

  async getSummary(tenantId: string): Promise<LoyaltySummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const memberWhere = { deletedAt: null, OR: [{ loyaltyEnrolledAt: { not: null } }, { loyaltyTier: { not: null } }, { loyaltyPoints: { gt: 0 } }] };
      // The five hundred biggest balances; the count is the real membership.
      const [guests, totalMembers] = await Promise.all([
        tx.guestProfile.findMany({
          where: memberWhere,
          select: { id: true, name: true, email: true, loyaltyTier: true, loyaltyPoints: true },
          orderBy: { loyaltyPoints: 'desc' },
          take: 500,
        }),
        tx.guestProfile.count({ where: memberWhere }),
      ]);

      const members: LoyaltyMember[] = guests.map((g) => ({
        id: g.id,
        name: g.name,
        email: g.email,
        loyaltyTier: g.loyaltyTier ?? 'Untiered',
        loyaltyPoints: g.loyaltyPoints ?? 0,
      }));

      const byTierMap = new Map<string, { memberCount: number; totalPoints: number }>();
      for (const m of members) {
        const entry = byTierMap.get(m.loyaltyTier) ?? { memberCount: 0, totalPoints: 0 };
        entry.memberCount += 1;
        entry.totalPoints += m.loyaltyPoints;
        byTierMap.set(m.loyaltyTier, entry);
      }
      const byTier: LoyaltyTierSummary[] = [...byTierMap.entries()].map(([tier, v]) => ({ tier, ...v })).sort((a, b) => b.totalPoints - a.totalPoints);

      return { members, byTier, totalMembers, totalPointsIssued: members.reduce((sum, m) => sum + m.loyaltyPoints, 0) };
    });
  }

  // -------------------------------------------------------------------------
  // Programme
  // -------------------------------------------------------------------------

  async getProgram(tenantId: string): Promise<LoyaltyProgramView> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [program, currencies] = await Promise.all([tx.loyaltyProgram.findUnique({ where: { tenantId } }), this.branchCurrencies(tx)]);
      if (!program) {
        return {
          configured: false,
          isActive: false,
          currency: currencies[0] ?? 'NGN',
          pointsPerUnit: '0.0100',
          pointValue: '1.0000',
          tiers: SUGGESTED_TIERS,
          pointsExpireAfterMonths: null,
          branchCurrencies: currencies,
          updatedAt: null,
        };
      }
      return this.toProgramView(program, currencies);
    });
  }

  /**
   * Saves the programme and brings every member's tier in line with it —
   * raising or lowering a threshold moves members across it straight away,
   * the same rule (highest tier their lifetime points reach) either way.
   */
  async saveProgram(tenantId: string, dto: SaveLoyaltyProgramDto, actorId: string): Promise<LoyaltyProgramView> {
    const tiers = sortTiers(dto.tiers.map((tier) => ({ name: tier.name.trim(), threshold: tier.threshold, benefits: [...new Set(tier.benefits)] })));
    const names = new Set<string>();
    const thresholds = new Set<number>();
    for (const tier of tiers) {
      if (!tier.name) throw invalid('Every tier needs a name');
      if (names.has(tier.name.toLowerCase())) throw invalid(`There are two tiers called "${tier.name}"`);
      if (thresholds.has(tier.threshold)) throw invalid(`Two tiers start at ${tier.threshold} points`);
      names.add(tier.name.toLowerCase());
      thresholds.add(tier.threshold);
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const currencies = await this.branchCurrencies(tx);
      if (!currencies.includes(dto.currency)) {
        throw invalid(`None of your branches charge in ${dto.currency} — choose ${currencies.join(' or ')}`);
      }
      const data = {
        isActive: dto.isActive,
        currency: dto.currency,
        pointsPerUnit: new Prisma.Decimal(dto.pointsPerUnit),
        pointValue: new Prisma.Decimal(dto.pointValue),
        tiers,
        // Left out, it stays as it was; points already earned keep the lapse date they were earned with.
        ...(dto.pointsExpireAfterMonths !== undefined ? { pointsExpireAfterMonths: dto.pointsExpireAfterMonths } : {}),
        updatedBy: actorId,
      };
      const program = await tx.loyaltyProgram.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });

      const lifetimes = await this.lifetimeByGuest(tx);
      const members = await tx.guestProfile.findMany({
        where: { deletedAt: null, OR: [{ loyaltyEnrolledAt: { not: null } }, { loyaltyPoints: { gt: 0 } }] },
        select: { id: true, loyaltyTier: true },
      });
      // One update per tier, not per member — re-tiering a few thousand
      // members one row at a time ran past the transaction's time limit.
      const movingTo = new Map<string | null, string[]>();
      for (const member of members) {
        const tierName = tierFor(tiers, lifetimes.get(member.id) ?? 0)?.name ?? null;
        if (tierName === member.loyaltyTier) continue;
        const group = movingTo.get(tierName);
        if (group) group.push(member.id);
        else movingTo.set(tierName, [member.id]);
      }
      let moved = 0;
      for (const [tierName, ids] of movingTo) {
        for (let i = 0; i < ids.length; i += 1000) {
          const chunk = ids.slice(i, i + 1000);
          await tx.guestProfile.updateMany({ where: { id: { in: chunk } }, data: { loyaltyTier: tierName } });
          moved += chunk.length;
        }
      }

      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actorId,
          action: 'loyalty_program.saved',
          entityType: 'loyalty_program',
          entityId: program.id,
          after: {
            isActive: dto.isActive,
            currency: dto.currency,
            pointsPerUnit: dto.pointsPerUnit,
            pointValue: dto.pointValue,
            tiers,
            pointsExpireAfterMonths: program.pointsExpireAfterMonths,
            membersRetiered: moved,
          },
        },
      });
      return this.toProgramView(program, currencies);
    }, { timeout: 60_000 });
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  async getGuestLoyalty(tenantId: string, guestId: string): Promise<GuestLoyaltyView> {
    return this.prisma.withTenant(tenantId, async (tx) => this.guestView(tx, tenantId, await this.findGuest(tx, guestId)));
  }

  async enroll(tenantId: string, guestId: string, actorId: string): Promise<GuestLoyaltyView> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const program = await tx.loyaltyProgram.findUnique({ where: { tenantId } });
      if (!program?.isActive) throw conflict('The loyalty programme is switched off — a manager can turn it on under Loyalty & Marketing');
      const guest = await this.lockGuest(tx, guestId);
      if (!guest.loyaltyEnrolledAt) {
        const lifetime = await this.lifetimePoints(tx, guest.id);
        await tx.guestProfile.update({
          where: { id: guest.id },
          data: { loyaltyEnrolledAt: new Date(), loyaltyTier: tierFor(parseTiers(program.tiers), lifetime)?.name ?? guest.loyaltyTier },
        });
        await tx.auditLog.create({ data: { tenantId, userId: actorId, action: 'loyalty.enrolled', entityType: 'guest_profile', entityId: guest.id } });
      }
      return this.guestView(tx, tenantId, await this.findGuest(tx, guestId));
    });
  }

  /** A manager's correction or goodwill. Can't take a balance below zero. */
  async adjust(tenantId: string, guestId: string, dto: AdjustPointsDto, actorId: string): Promise<GuestLoyaltyView> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const guest = await this.lockGuest(tx, guestId);
      const balance = guest.loyaltyPoints ?? 0;
      if (balance + dto.points < 0) throw conflict(`${guest.name} has ${balance.toLocaleString('en-US')} points — you can take off at most that many`);
      await this.applyPoints(tx, tenantId, guest, { type: 'adjust', points: dto.points, description: dto.reason.trim(), actorId });
      await tx.auditLog.create({
        data: { tenantId, userId: actorId, action: 'loyalty.adjusted', entityType: 'guest_profile', entityId: guest.id, after: { points: dto.points, reason: dto.reason.trim() } },
      });
      return this.guestView(tx, tenantId, await this.findGuest(tx, guestId));
    });
  }

  /**
   * Called from `ReservationsService.checkOut`, inside its transaction. Earns
   * on every non-tax line across the stay's folios — room, extras, charges
   * rung up at an outlet, corrections netted — so the points match what the
   * stay actually cost before tax. Only at a branch that charges in the
   * programme's currency, once per stay (the unique `earnReservationId`), and
   * enrols the guest if they weren't already. Returns the points earned.
   */
  async earnForStayInTx(tx: TenantTx, reservation: Reservation, actorId: string | null): Promise<number> {
    const program = await tx.loyaltyProgram.findUnique({ where: { tenantId: reservation.tenantId } });
    if (!program?.isActive) return 0;
    const branch = await tx.branch.findFirst({ where: { id: reservation.branchId }, select: { currency: true } });
    if (branch?.currency !== program.currency) return 0;
    if (await tx.loyaltyTransaction.findFirst({ where: { earnReservationId: reservation.id }, select: { id: true } })) return 0;

    const spend = await tx.lineItem.aggregate({
      _sum: { amount: true },
      where: { folio: { reservationId: reservation.id }, chargeType: { not: 'tax' }, isVoid: false, deletedAt: null },
    });
    const spendBeforeTax = spend._sum.amount ?? new Prisma.Decimal(0);
    const points = pointsForSpend(spendBeforeTax, program.pointsPerUnit);
    if (points <= 0) return 0;

    const guest = await this.lockGuest(tx, reservation.guestId).catch(() => null);
    if (!guest) return 0;
    const { upgradedTo } = await this.applyPoints(tx, reservation.tenantId, guest, {
      type: 'earn',
      points,
      description: `Stay ${reservation.confirmationNumber} — ${program.currency} ${spendBeforeTax.toFixed(2)} before tax`,
      branchId: reservation.branchId,
      earnReservationId: reservation.id,
      expiresAt: pointsExpireAt(new Date(), program.pointsExpireAfterMonths),
      actorId,
    });
    if (upgradedTo) {
      await this.commsLogService.logAutomatedInTx(tx, reservation.tenantId, reservation.branchId, {
        reservationId: reservation.id,
        guestId: guest.id,
        channel: 'email',
        subject: `Welcome to ${upgradedTo.name}`,
        body: `Congratulations — your stay took you to ${upgradedTo.name}.${upgradedTo.benefits.length > 0 ? ` Your benefits: ${upgradedTo.benefits.map((b) => b.replace(/_/g, ' ')).join(', ')}.` : ''}`,
        trigger: 'loyalty_tier_upgrade',
      });
    }
    return points;
  }

  /**
   * Pays part or all of a bill with the guest's points. The folio's own
   * guest redeems; the payment is capped at what the bill still owes (a
   * credit would be refunded as cash); points and payment are written
   * together.
   */
  async redeem(tenantId: string, folioId: string, points: number, actor: JwtPayload): Promise<RedemptionResult> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const folio = await tx.folio.findFirst({ where: { id: folioId, deletedAt: null } });
      if (!folio) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Folio not found' });
      assertRoleAtBranch(actor, folio.branchId, REDEEM_ROLES);

      const program = await tx.loyaltyProgram.findUnique({ where: { tenantId } });
      if (!program?.isActive) throw conflict('The loyalty programme is switched off');
      const branch = await tx.branch.findFirst({ where: { id: folio.branchId }, select: { currency: true } });
      if (branch?.currency !== program.currency) throw conflict(`Points are redeemed in ${program.currency}; this branch charges in ${branch?.currency ?? 'another currency'}`);

      const guest = await this.lockGuest(tx, folio.guestId);
      const balance = guest.loyaltyPoints ?? 0;
      if (points > balance) throw conflict(`${guest.name} has ${balance.toLocaleString('en-US')} points`);
      const amount = redemptionValue(points, program.pointValue);
      if (!amount.greaterThan(0)) throw invalid(`${points} points aren't worth anything yet — each is worth ${program.currency} ${program.pointValue.toFixed(4)}`);

      const payment = await this.foliosService.recordLoyaltyPaymentInTx(tx, folio.id, amount, `${points.toLocaleString('en-US')} loyalty points`, actor.sub);
      await this.applyPoints(tx, tenantId, guest, {
        type: 'redeem',
        points: -points,
        description: `Redeemed for ${program.currency} ${amount.toFixed(2)} on the bill`,
        branchId: folio.branchId,
        paymentId: payment.id,
        actorId: actor.sub,
      });
      return { paymentId: payment.id, pointsRedeemed: points, amount: amount.toFixed(2), currency: program.currency, balance: balance - points };
    });
  }

  /**
   * The nightly sweep: takes off every member's points that have lapsed
   * unspent, as an `expire` row each — oldest earnings first (see
   * `lapsedPoints`). Tenant by tenant (the ledger is behind row-level
   * security), in batches of members. Lifetime points, and so tiers, don't
   * change: a lapse isn't spending. Returns how many points lapsed.
   */
  async expireLapsedPoints(now = new Date()): Promise<number> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: { in: ['trial', 'active'] } }, select: { id: true } });
    let lapsed = 0;
    for (const tenant of tenants) {
      const candidates = await this.prisma.withTenant(tenant.id, async (tx) => {
        const rows = await tx.loyaltyTransaction.groupBy({ by: ['guestId'], where: { type: 'earn', expiresAt: { lte: now }, guest: { loyaltyPoints: { gt: 0 } } } });
        return rows.map((row) => row.guestId);
      });
      for (let i = 0; i < candidates.length; i += 200) {
        const batch = candidates.slice(i, i + 200);
        lapsed += await this.prisma.withTenant(
          tenant.id,
          async (tx) => {
            let points = 0;
            for (const guestId of batch) {
              const guest = await this.lockGuest(tx, guestId).catch(() => null);
              if (!guest) continue;
              const ledger = await tx.loyaltyTransaction.findMany({ where: { guestId }, select: { type: true, points: true, expiresAt: true } });
              const { due } = lapsedPoints(ledger, now);
              if (due <= 0) continue;
              await this.applyPoints(tx, tenant.id, guest, {
                type: 'expire',
                points: -due,
                description: `${due.toLocaleString('en-US')} points lapsed unspent`,
                actorId: null,
              });
              points += due;
            }
            return points;
          },
          { timeout: 60_000 },
        );
      }
    }
    return lapsed;
  }

  // -------------------------------------------------------------------------

  /** Writes one ledger row and moves the balance and tier with it. Callers hold the guest row lock. */
  private applyPoints(tx: TenantTx, tenantId: string, guest: GuestProfile, entry: LoyaltyEntry): Promise<{ upgradedTo: LoyaltyTier | null }> {
    return applyLoyaltyPoints(tx, tenantId, guest, entry);
  }

  private async guestView(tx: TenantTx, tenantId: string, guest: GuestProfile): Promise<GuestLoyaltyView> {
    const program = await tx.loyaltyProgram.findUnique({ where: { tenantId } });
    const tiers = parseTiers(program?.tiers);
    const lifetime = await this.lifetimePoints(tx, guest.id);
    const transactions = await tx.loyaltyTransaction.findMany({
      where: { guestId: guest.id },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_ROWS,
      select: { id: true, type: true, points: true, description: true, createdAt: true },
    });
    const balance = guest.loyaltyPoints ?? 0;
    const ledger = await tx.loyaltyTransaction.findMany({ where: { guestId: guest.id }, select: { type: true, points: true, expiresAt: true } });
    return {
      guestId: guest.id,
      programActive: program?.isActive ?? false,
      currency: program?.currency ?? null,
      pointValue: program ? program.pointValue.toFixed(4) : null,
      enrolledAt: guest.loyaltyEnrolledAt,
      balance,
      lifetimePoints: lifetime,
      tier: program ? tierFor(tiers, lifetime) : null,
      tierName: guest.loyaltyTier,
      nextTier: program ? nextTierFor(tiers, lifetime) : null,
      redeemableValue: program ? redemptionValue(balance, program.pointValue).toFixed(2) : null,
      expiring: lapsedPoints(ledger, new Date()).next,
      transactions,
    };
  }

  private findGuest(tx: TenantTx, guestId: string): Promise<GuestProfile> {
    return findLoyaltyGuest(tx, guestId);
  }

  /** Serialises everything that moves one guest's points: two redemptions at once can't both spend the same balance. */
  private lockGuest(tx: TenantTx, guestId: string): Promise<GuestProfile> {
    return lockLoyaltyGuest(tx, guestId);
  }

  /** Everything ever earned or added — what tiers go by. Never falls when points are spent. */
  private lifetimePoints(tx: TenantTx, guestId: string): Promise<number> {
    return lifetimeLoyaltyPoints(tx, guestId);
  }

  private async lifetimeByGuest(tx: TenantTx): Promise<Map<string, number>> {
    const rows = await tx.loyaltyTransaction.groupBy({ by: ['guestId'], where: LIFETIME_POINTS_WHERE, _sum: { points: true } });
    return new Map(rows.map((row) => [row.guestId, row._sum.points ?? 0]));
  }

  private async branchCurrencies(tx: TenantTx): Promise<string[]> {
    const branches = await tx.branch.findMany({ where: { deletedAt: null }, select: { currency: true }, distinct: ['currency'], orderBy: { createdAt: 'asc' } });
    return branches.map((b) => b.currency);
  }

  private toProgramView(program: LoyaltyProgram, currencies: string[]): LoyaltyProgramView {
    return {
      configured: true,
      isActive: program.isActive,
      currency: program.currency,
      pointsPerUnit: program.pointsPerUnit.toFixed(4),
      pointValue: program.pointValue.toFixed(4),
      tiers: parseTiers(program.tiers),
      pointsExpireAfterMonths: program.pointsExpireAfterMonths,
      branchCurrencies: currencies,
      updatedAt: program.updatedAt,
    };
  }
}
