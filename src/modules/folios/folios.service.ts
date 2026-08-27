import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ChargeType, Folio, LineItem, Payment, Prisma, Reservation } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { TaxesService } from '../taxes/taxes.service';
import { CorrectLineItemDto, PostChargeDto, RecordPaymentDto } from './dto/folio.dto';

const ZERO = new Prisma.Decimal(0);

/** A folio's money, all derived — nothing here is ever stored (spec §4.5). */
export interface FolioTotals {
  subTotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  totalCost: Prisma.Decimal;
  paymentsTotal: Prisma.Decimal;
  depositsTotal: Prisma.Decimal;
  balanceDue: Prisma.Decimal;
}

/**
 * Guest-ledger vs city-ledger, derived rather than stored — mirrors the
 * in-house PMS (`five-clover-nestjs-backend/docs/PMS-OPERATIONS-GUIDE.md`):
 * a still-checked-in guest who owes is a Guest Ledger matter front desk can
 * resolve before departure; a departed guest who still owes is a City
 * Ledger receivable, i.e. collections. Never blocks anything — it's a label.
 */
export type FolioGuestStatus = 'in_house' | 'city_ledger' | null;

@Injectable()
export class FoliosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    private readonly taxesService: TaxesService,
  ) {}

  // -------------------------------------------------------------------------
  // Provisioning + room-night accrual (called from ReservationsService)
  // -------------------------------------------------------------------------

  /**
   * Idempotent: returns the reservation's primary folio (`label: null`) or
   * creates one. Called at check-in/walk-in AND lazily on reads and
   * check-out, so a reservation checked in before this module existed still
   * resolves a folio (empty → balance 0) instead of 404-ing.
   */
  async ensurePrimaryFolio(tx: TenantTx, reservation: Reservation, actorId: string): Promise<Folio> {
    const existing = await tx.folio.findFirst({
      where: { reservationId: reservation.id, label: null, deletedAt: null },
    });
    if (existing) return existing;

    const folio = await tx.folio.create({
      data: {
        tenantId: reservation.tenantId,
        branchId: reservation.branchId,
        reservationId: reservation.id,
        guestId: reservation.guestId,
        status: 'open',
        openedAt: new Date(),
      },
    });
    await this.audit(tx, reservation.tenantId, reservation.branchId, actorId, 'folio.opened', folio.id, {
      reservationId: reservation.id,
    });
    return folio;
  }

  /**
   * Posts ONE night's room charge, plus its taxes — the shared accrual
   * function. Mirrors the in-house PMS's `postStayChargesForDay`
   * (`reservations.service.ts:1525`) and the identical block in its night
   * audit: check-in posts the arrival night, night audit posts each
   * subsequent night, both through this one function and both guarded the
   * same way.
   *
   * **The guard is what makes night audit safe to add later**: an existing
   * `room` line item with this `serviceDate` short-circuits the post, so a
   * future night-audit loop can never double-charge a night that check-in
   * (or a re-run) already billed. Night audit MUST call this rather than
   * re-implement it.
   *
   * Rate comes from the reservation's OWN stored figures, not the room
   * type's live `baseRate` — so a manager's rate override or a
   * discount applies to every night of the stay, not just whichever night
   * happened to be posted first. (`overrideRate` is an absolute nightly
   * rate; `confirmedRate` is the stay total.)
   */
  async postRoomChargeForDate(
    tx: TenantTx,
    reservation: Reservation & { roomType?: { name: string } | null },
    folio: Folio,
    serviceDate: Date,
    label: string,
    actorId: string,
  ): Promise<LineItem | null> {
    const already = await tx.lineItem.findFirst({
      where: { folioId: folio.id, chargeType: 'room', serviceDate, isVoid: false, deletedAt: null },
    });
    if (already) return null;

    const nights = Math.max(
      1,
      Math.round((reservation.checkOutDate.getTime() - reservation.checkInDate.getTime()) / 86_400_000),
    );
    const perNight = reservation.overrideRate
      ? new Prisma.Decimal(reservation.overrideRate)
      : new Prisma.Decimal(reservation.confirmedRate).div(nights).toDecimalPlaces(2);

    if (perNight.lessThanOrEqualTo(0)) return null; // nothing to charge; CHECK (amount <> 0) would reject it anyway

    const roomTypeName = reservation.roomType?.name ?? 'Room';
    const dateLabel = serviceDate.toISOString().slice(0, 10);
    // Tagging the source ("Check-in" / "Night Audit") keeps a system-posted
    // charge distinguishable from a hand-posted one at a glance — the
    // in-house PMS learned this the hard way chasing a pricing bug.
    const description = `Room Charge — ${label}, ${dateLabel} (${roomTypeName})`;

    return this.writeChargeWithTaxes(tx, {
      tenantId: reservation.tenantId,
      branchId: reservation.branchId,
      folioId: folio.id,
      description,
      amount: perNight,
      chargeType: 'room',
      serviceDate,
      actorId,
    });
  }

  // -------------------------------------------------------------------------
  // Charges, payments, corrections
  // -------------------------------------------------------------------------

  async postCharge(tenantId: string, folioId: string, dto: PostChargeDto, actorId: string): Promise<LineItem> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const folio = await this.findFolioOrThrow(tx, folioId);
      this.assertFolioOpen(folio);
      const branch = await this.propertyService.assertBranch(tx, folio.branchId);
      const serviceDate = toBranchDate(dto.serviceDate ?? todayInTimezone(branch.timezone));

      const lineItem = await this.writeChargeWithTaxes(tx, {
        tenantId,
        branchId: folio.branchId,
        folioId,
        description: dto.description,
        amount: new Prisma.Decimal(dto.amount),
        chargeType: dto.chargeType,
        serviceDate,
        actorId,
      });
      if (!lineItem) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Charge amount must be non-zero' });
      }
      return lineItem;
    });
  }

  async recordPayment(tenantId: string, folioId: string, dto: RecordPaymentDto, actorId: string): Promise<Payment> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const folio = await this.findFolioOrThrow(tx, folioId);
      this.assertFolioOpen(folio);
      const branch = await this.propertyService.assertBranch(tx, folio.branchId);

      const payment = await tx.payment.create({
        data: {
          tenantId,
          folioId,
          method: dto.method,
          amount: new Prisma.Decimal(dto.amount),
          currency: branch.currency,
          reference: dto.reference,
          paymentPurpose: dto.paymentPurpose ?? 'payment',
          recordedBy: actorId,
        },
      });
      await this.audit(tx, tenantId, folio.branchId, actorId, 'payment.recorded', payment.id, {
        folioId,
        amount: dto.amount,
        method: dto.method,
      });
      return payment;
    });
  }

  /**
   * Append-only correction (spec §4.5: "no UPDATE of amounts, no DELETE.
   * Corrections = new negative line item"). The original row is never
   * touched — it stays in the ledger exactly as posted, and a new
   * `correction` row carries the negation plus a mandatory reason.
   */
  async correctLineItem(tenantId: string, lineItemId: string, dto: CorrectLineItemDto, actorId: string): Promise<LineItem> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const original = await tx.lineItem.findFirst({ where: { id: lineItemId, deletedAt: null } });
      if (!original) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Line item not found' });
      }
      const folio = await this.findFolioOrThrow(tx, original.folioId);
      this.assertFolioOpen(folio);

      const correction = await tx.lineItem.create({
        data: {
          tenantId,
          folioId: original.folioId,
          description: `Correction — ${original.description} (${dto.reason})`.slice(0, 300),
          amount: original.amount.negated(),
          chargeType: 'correction',
          serviceDate: original.serviceDate,
          postedBy: actorId,
        },
      });
      await this.audit(tx, tenantId, folio.branchId, actorId, 'line_item.corrected', correction.id, {
        originalLineItemId: lineItemId,
        reason: dto.reason,
      });
      return correction;
    });
  }

  /** The ONLY place `FOLIO_NOT_SETTLED` is thrown. Check-out deliberately does not use it — see `ReservationsService.checkOut`. */
  async closeFolio(tenantId: string, folioId: string, actorId: string): Promise<Folio> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const folio = await this.findFolioOrThrow(tx, folioId);
      if (folio.status === 'settled') return folio;
      const totals = await this.computeTotals(tx, folioId);
      if (totals.balanceDue.greaterThan(0)) {
        throw new ConflictException({
          code: ErrorCode.FOLIO_NOT_SETTLED,
          message: `Folio still has an outstanding balance of ${totals.balanceDue.toFixed(2)}`,
        });
      }
      const settled = await tx.folio.update({
        where: { id: folioId },
        data: { status: 'settled', closedAt: new Date() },
      });
      await this.audit(tx, tenantId, folio.branchId, actorId, 'folio.closed', folioId, {
        balanceDue: totals.balanceDue.toFixed(2),
      });
      return settled;
    });
  }

  /** Settles a folio if it is fully paid, WITHOUT throwing when it isn't — the check-out path (which must never block). Returns whether it settled. */
  async settleIfFullyPaid(tx: TenantTx, folio: Folio, actorId: string): Promise<boolean> {
    const totals = await this.computeTotals(tx, folio.id);
    if (totals.balanceDue.greaterThan(0)) return false;
    await tx.folio.update({ where: { id: folio.id }, data: { status: 'settled', closedAt: new Date() } });
    await this.audit(tx, folio.tenantId, folio.branchId, actorId, 'folio.closed', folio.id, {
      balanceDue: totals.balanceDue.toFixed(2),
      viaCheckOut: true,
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getFolio(tenantId: string, folioId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const folio = await tx.folio.findFirst({
        where: { id: folioId, deletedAt: null },
        include: {
          guest: { select: { id: true, name: true, email: true, phone: true } },
          reservation: {
            select: {
              id: true,
              confirmationNumber: true,
              status: true,
              checkInDate: true,
              checkOutDate: true,
              confirmedRate: true,
              roomType: { select: { id: true, name: true } },
              room: { select: { id: true, number: true } },
            },
          },
        },
      });
      if (!folio) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Folio not found' });
      }
      const [lineItems, payments, totals, branch] = await Promise.all([
        tx.lineItem.findMany({ where: { folioId, deletedAt: null }, orderBy: { postedAt: 'asc' } }),
        tx.payment.findMany({ where: { folioId, deletedAt: null }, orderBy: { recordedAt: 'asc' } }),
        this.computeTotals(tx, folioId),
        this.propertyService.assertBranch(tx, folio.branchId),
      ]);
      return {
        ...folio,
        lineItems,
        payments,
        totals,
        // The branch's ISO 4217 code travels with every money response so
        // the client never has to guess (or fetch the branch separately)
        // which symbol to render amounts in.
        currency: branch.currency,
        guestStatus: this.deriveGuestStatus(folio.reservation?.status ?? null, totals.balanceDue),
      };
    });
  }

  /** Per-rule GROUP BY over the folio's tax line items (spec §4.5, ref p33's Tax Breakdown table). */
  async getTaxBreakdown(tenantId: string, folioId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.findFolioOrThrow(tx, folioId);
      const [taxItems, rules] = await Promise.all([
        tx.lineItem.findMany({ where: { folioId, chargeType: 'tax', isVoid: false, deletedAt: null } }),
        tx.taxRule.findMany({}),
      ]);
      const ruleById = new Map(rules.map((r) => [r.id, r]));
      const grouped = new Map<string, { ruleId: string; ruleName: string; rate: Prisma.Decimal; taxCollected: Prisma.Decimal }>();

      for (const item of taxItems) {
        const ruleId = item.taxRuleIds[0];
        if (!ruleId) continue;
        const rule = ruleById.get(ruleId);
        const entry = grouped.get(ruleId) ?? {
          ruleId,
          ruleName: rule?.name ?? 'Unknown rule',
          rate: rule?.rate ?? ZERO,
          taxCollected: ZERO,
        };
        entry.taxCollected = entry.taxCollected.plus(item.amount);
        grouped.set(ruleId, entry);
      }

      const rows = [...grouped.values()].map((entry) => ({
        ...entry,
        // Reverse out the base this rule actually taxed, rather than
        // re-deriving it from line items — the rate may have changed since,
        // and the collected amount is the fact that was recorded.
        taxableBase: entry.rate.isZero() ? ZERO : entry.taxCollected.div(entry.rate).toDecimalPlaces(2),
      }));
      const totalTax = rows.reduce((sum, r) => sum.plus(r.taxCollected), ZERO);
      return { rows, totalTax };
    });
  }

  async listFoliosForReservation(tenantId: string, reservationId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.folio.findMany({ where: { reservationId, deletedAt: null }, orderBy: { openedAt: 'asc' } }),
    );
  }

  /**
   * Branch folio list with the in-house PMS's own filter vocabulary:
   * "outstanding" = open with a balance owed; "overdue" = outstanding AND
   * the guest's check-out date has already passed (i.e. a City Ledger
   * receivable) — `PMS-OPERATIONS-GUIDE.md:221`.
   */
  async listFolios(tenantId: string, branchId: string, filter: 'all' | 'outstanding' | 'overdue') {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const folios = await tx.folio.findMany({
        where: { branchId, deletedAt: null, ...(filter === 'all' ? {} : { status: { not: 'settled' } }) },
        include: {
          guest: { select: { id: true, name: true } },
          reservation: {
            select: { id: true, confirmationNumber: true, status: true, checkOutDate: true, room: { select: { number: true } } },
          },
        },
        orderBy: { openedAt: 'desc' },
      });

      const today = toBranchDate(todayInTimezone(branch.timezone));
      const rows = await Promise.all(
        folios.map(async (folio) => {
          const totals = await this.computeTotals(tx, folio.id);
          return {
            id: folio.id,
            status: folio.status,
            openedAt: folio.openedAt,
            closedAt: folio.closedAt,
            guest: folio.guest,
            reservation: folio.reservation,
            balanceDue: totals.balanceDue,
            currency: branch.currency,
            guestStatus: this.deriveGuestStatus(folio.reservation?.status ?? null, totals.balanceDue),
          };
        }),
      );

      if (filter === 'outstanding') return rows.filter((r) => r.balanceDue.greaterThan(0));
      if (filter === 'overdue') {
        return rows.filter((r) => r.balanceDue.greaterThan(0) && r.reservation != null && r.reservation.checkOutDate < today);
      }
      return rows;
    });
  }

  // -------------------------------------------------------------------------
  // Shared internals
  // -------------------------------------------------------------------------

  /**
   * Writes a charge and its tax rows atomically. The parent carries
   * `taxAmount` as a DISPLAY denormalisation only (the reference's
   * "20,000 NGN +345 tax" per-line suffix) — the ledger entry for tax is
   * the separate `chargeType: 'tax'` row, and balance sums `amount` alone,
   * so nothing is double-counted.
   */
  private async writeChargeWithTaxes(
    tx: TenantTx,
    input: {
      tenantId: string;
      branchId: string;
      folioId: string;
      description: string;
      amount: Prisma.Decimal;
      chargeType: ChargeType;
      serviceDate: Date;
      actorId: string;
    },
  ): Promise<LineItem | null> {
    if (input.amount.isZero()) return null;

    const taxes = await this.taxesService.computeTaxesForCharge(tx, input.branchId, input.chargeType, input.amount);
    const taxTotal = taxes.reduce((sum, t) => sum.plus(t.taxAmount), ZERO);

    const parent = await tx.lineItem.create({
      data: {
        tenantId: input.tenantId,
        folioId: input.folioId,
        description: input.description,
        amount: input.amount,
        taxAmount: taxTotal,
        chargeType: input.chargeType,
        serviceDate: input.serviceDate,
        postedBy: input.actorId,
      },
    });

    for (const tax of taxes) {
      await tx.lineItem.create({
        data: {
          tenantId: input.tenantId,
          folioId: input.folioId,
          description: `${tax.ruleName} (${tax.rate.mul(100).toDecimalPlaces(2).toString()}%) — ${input.description}`.slice(0, 300),
          amount: tax.taxAmount,
          chargeType: 'tax',
          taxRuleIds: [tax.ruleId],
          serviceDate: input.serviceDate,
          postedBy: input.actorId,
        },
      });
    }

    await this.audit(tx, input.tenantId, input.branchId, input.actorId, 'line_item.posted', parent.id, {
      folioId: input.folioId,
      chargeType: input.chargeType,
      amount: input.amount.toFixed(2),
      taxAmount: taxTotal.toFixed(2),
    });
    return parent;
  }

  /** `balance = SUM(line_items not void/deleted) − SUM(payments not void)` — computed, never stored (spec §4.5). */
  private async computeTotals(tx: TenantTx, folioId: string): Promise<FolioTotals> {
    const [lineItems, payments] = await Promise.all([
      tx.lineItem.findMany({
        where: { folioId, isVoid: false, deletedAt: null },
        select: { amount: true, chargeType: true },
      }),
      tx.payment.findMany({ where: { folioId, isVoid: false, deletedAt: null }, select: { amount: true, paymentPurpose: true } }),
    ]);

    let subTotal = ZERO;
    let taxTotal = ZERO;
    for (const item of lineItems) {
      if (item.chargeType === 'tax') taxTotal = taxTotal.plus(item.amount);
      else subTotal = subTotal.plus(item.amount);
    }
    let paymentsTotal = ZERO;
    let depositsTotal = ZERO;
    for (const payment of payments) {
      paymentsTotal = paymentsTotal.plus(payment.amount);
      if (payment.paymentPurpose === 'deposit') depositsTotal = depositsTotal.plus(payment.amount);
    }

    const totalCost = subTotal.plus(taxTotal);
    return { subTotal, taxTotal, totalCost, paymentsTotal, depositsTotal, balanceDue: totalCost.minus(paymentsTotal) };
  }

  private deriveGuestStatus(reservationStatus: string | null, balanceDue: Prisma.Decimal): FolioGuestStatus {
    if (!balanceDue.greaterThan(0)) return null;
    if (reservationStatus === 'checked_out') return 'city_ledger';
    if (reservationStatus === 'checked_in') return 'in_house';
    return null;
  }

  private async findFolioOrThrow(tx: TenantTx, folioId: string): Promise<Folio> {
    const folio = await tx.folio.findFirst({ where: { id: folioId, deletedAt: null } });
    if (!folio) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Folio not found' });
    }
    return folio;
  }

  private assertFolioOpen(folio: Folio): void {
    if (folio.status === 'settled') {
      throw new ConflictException({
        code: ErrorCode.CONFLICT,
        message: 'Folio is settled — reopen it before posting anything further',
      });
    }
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
    await tx.auditLog.create({
      data: { tenantId, branchId, userId, action, entityType: 'folio', entityId, after },
    });
  }
}
