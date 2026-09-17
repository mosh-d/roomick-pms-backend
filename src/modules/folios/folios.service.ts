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
  async ensurePrimaryFolio(tx: TenantTx, reservation: Reservation, actorId: string | null): Promise<Folio> {
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
    actorId: string | null,
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

  /**
   * The same cross-service, in-transaction posting primitive
   * `postRoomChargeForDate` is, generalized for a caller that isn't posting
   * a room night — currently just no-show penalties (`ReservationsService
   * .markNoShowInTx`) and their waiver reversal (a negative `amount`,
   * `chargeType: 'correction'` — the append-only ledger discipline
   * `correctLineItem` uses for a hand-posted charge, applied here too;
   * taxes reverse proportionally for free since `writeChargeWithTaxes`
   * computes them off whatever `amount` it's given, signed).
   */
  async postAdHocCharge(
    tx: TenantTx,
    reservation: Reservation,
    folio: Folio,
    chargeType: ChargeType,
    amount: Prisma.Decimal,
    description: string,
    actorId: string | null,
  ): Promise<LineItem | null> {
    return this.writeChargeWithTaxes(tx, {
      tenantId: reservation.tenantId,
      branchId: reservation.branchId,
      folioId: folio.id,
      description,
      amount,
      chargeType,
      serviceDate: reservation.checkInDate,
      actorId,
    });
  }

  /**
   * A Point of Sale "charge to room": the whole order as one line, stamped
   * with the outlet and the outlet's charge type, taxed by the branch's rules
   * like any other charge. The caller has already checked the folio is open.
   */
  async postOutletCharge(
    tx: TenantTx,
    input: {
      folio: Folio;
      outletId: string;
      chargeType: ChargeType;
      amount: Prisma.Decimal;
      description: string;
      serviceDate: Date;
      actorId: string;
    },
  ): Promise<LineItem | null> {
    return this.writeChargeWithTaxes(tx, {
      tenantId: input.folio.tenantId,
      branchId: input.folio.branchId,
      folioId: input.folio.id,
      description: input.description,
      amount: input.amount,
      chargeType: input.chargeType,
      serviceDate: input.serviceDate,
      outletId: input.outletId,
      actorId: input.actorId,
    });
  }

  /** The tax `writeChargeWithTaxes` would add to a charge — for quoting one (a cancellation charge, a POS basket) before it's posted. Same rules, same rounding, nothing written. */
  async previewTaxTotal(tx: TenantTx, branchId: string, chargeType: ChargeType, amount: Prisma.Decimal): Promise<Prisma.Decimal> {
    const taxes = await this.taxesService.computeTaxesForCharge(tx, branchId, chargeType, amount);
    return taxes.reduce((sum, t) => sum.plus(t.taxAmount), ZERO);
  }

  /** Payments recorded on a reservation's primary folio; zero when it has none yet. Read-only — never creates a folio. */
  async paidOnPrimaryFolio(tx: TenantTx, reservationId: string): Promise<Prisma.Decimal> {
    const folio = await tx.folio.findFirst({ where: { reservationId, label: null, deletedAt: null }, select: { id: true } });
    if (!folio) return ZERO;
    return (await this.computeTotals(tx, folio.id)).paymentsTotal;
  }

  /**
   * Posts every night of the stay that has actually elapsed and isn't
   * already billed. Each night goes through `postRoomChargeForDate`, so
   * the per-date guard makes this safe to call repeatedly.
   *
   * This is the check-out **safety net** — the in-house PMS runs the same
   * one for exactly this reason: a guest who leaves before the night audit
   * next runs would otherwise walk out with un-posted nights. Nights are
   * counted `[checkInDate, checkOutDate)` — the departure day itself is
   * never a billable night — and capped at `today`, so a guest leaving
   * early is never charged for nights they didn't stay.
   */
  async backfillRoomCharges(
    tx: TenantTx,
    reservation: Reservation & { roomType?: { name: string } | null },
    folio: Folio,
    today: Date,
    label: string,
    actorId: string,
  ): Promise<number> {
    let posted = 0;
    const lastBillable = today < reservation.checkOutDate ? today : reservation.checkOutDate;
    for (
      let night = new Date(reservation.checkInDate);
      night < lastBillable;
      night.setUTCDate(night.getUTCDate() + 1)
    ) {
      const result = await this.postRoomChargeForDate(tx, reservation, folio, new Date(night), label, actorId);
      if (result) posted++;
    }
    return posted;
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
    // A points payment has to come off a points balance, and only the loyalty
    // redemption writes both halves together.
    if (dto.method === 'loyalty_points') {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: "Loyalty points are redeemed from the guest's balance — use Redeem Points on the bill",
      });
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const folio = await this.findFolioOrThrow(tx, folioId);
      this.assertFolioOpen(folio);
      const branch = await this.propertyService.assertBranch(tx, folio.branchId);

      // Cash reconciliation (Shift Management) needs every cash payment
      // attributed to the drawer it landed in — the recording agent's own
      // currently open shift on this branch, if they have one. Non-cash
      // methods never touch a shift; a card/bank/voucher payment isn't
      // counted-cash at close, so linking it would just be noise.
      const openShift =
        dto.method === 'cash'
          ? await tx.shift.findFirst({ where: { branchId: folio.branchId, agentId: actorId, closedAt: null } })
          : null;

      const payment = await tx.payment.create({
        data: {
          tenantId,
          folioId,
          method: dto.method,
          amount: new Prisma.Decimal(dto.amount),
          currency: branch.currency,
          reference: dto.reference,
          shiftId: openShift?.id,
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
   * The payment half of a loyalty redemption — only `LoyaltyService.redeem`
   * writes these, in the same transaction as the points coming off. Capped at
   * what the bill still owes: points can settle a bill, never leave a credit
   * that would go back to the guest as cash.
   */
  async recordLoyaltyPaymentInTx(tx: TenantTx, folioId: string, amount: Prisma.Decimal, reference: string, actorId: string): Promise<Payment> {
    const folio = await this.findFolioOrThrow(tx, folioId);
    this.assertFolioOpen(folio);
    const { balanceDue } = await this.computeTotals(tx, folioId);
    if (amount.greaterThan(balanceDue)) {
      throw new ConflictException({
        code: ErrorCode.CONFLICT,
        message: `Those points are worth ${amount.toFixed(2)}, more than the ${balanceDue.greaterThan(0) ? balanceDue.toFixed(2) : '0.00'} this bill owes`,
      });
    }
    const branch = await this.propertyService.assertBranch(tx, folio.branchId);
    const payment = await tx.payment.create({
      data: {
        tenantId: folio.tenantId,
        folioId,
        method: 'loyalty_points',
        amount,
        currency: branch.currency,
        reference,
        paymentPurpose: 'payment',
        recordedBy: actorId,
      },
    });
    await this.audit(tx, folio.tenantId, folio.branchId, actorId, 'payment.recorded', payment.id, {
      folioId,
      amount: amount.toFixed(2),
      method: 'loyalty_points',
    });
    return payment;
  }

  /**
   * Append-only correction (spec §4.5: "no UPDATE of amounts, no DELETE.
   * Corrections = new negative line item"). The original row is never
   * touched — it stays in the ledger exactly as posted, and a new reversing
   * row carries the negation plus a mandatory reason.
   *
   * **A charge's tax is reversed with it.** This used to negate only the
   * charge line and leave its tax lines standing — found through the guest
   * bill view, where correcting a ₦5,000 minibar charge still left ₦375 VAT
   * owing on an item whose net charge was zero. Tax lines now record the
   * charge they were computed on (`parentLineItemId`), so correcting a charge
   * also appends a negating line for each of its taxes.
   *
   * Each tax reversal keeps the `tax` category and the original rule ids, so
   * tax totals and the Tax Breakdown net down — rather than the reversal
   * landing in the charges subtotal while reported tax stays inflated. The
   * reversals point at the new correction row as their parent, mirroring how
   * the originals point at the original charge, so reversing a correction
   * (reinstating a charge) reinstates its tax too.
   *
   * Correcting a tax line on its own — a tax-exempt guest, say — is allowed
   * and produces a negating `tax` line for that one rule.
   *
   * A line can be corrected once (`correctsLineItemId` is unique): a second
   * correction would reverse the charge, and now its tax, twice. Tax lines
   * posted before the link existed have no parent, so correcting one of
   * those older charges still reverses only the charge.
   */
  async correctLineItem(tenantId: string, lineItemId: string, dto: CorrectLineItemDto, actorId: string): Promise<LineItem> {
    return this.prisma.withTenant(tenantId, (tx) => this.correctLineItemInTx(tx, tenantId, lineItemId, dto.reason, actorId));
  }

  /** `correctLineItem` inside a caller's transaction — voiding a Point of Sale room charge takes it off the bill through here. */
  async correctLineItemInTx(tx: TenantTx, tenantId: string, lineItemId: string, reason: string, actorId: string): Promise<LineItem> {
    const original = await tx.lineItem.findFirst({ where: { id: lineItemId, deletedAt: null } });
    if (!original) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Line item not found' });
    }
    const folio = await this.findFolioOrThrow(tx, original.folioId);
    this.assertFolioOpen(folio);

    const alreadyCorrected = await tx.lineItem.findFirst({ where: { correctsLineItemId: original.id }, select: { id: true } });
    if (alreadyCorrected) throw this.alreadyCorrected();

    const isTaxLine = original.chargeType === 'tax';
    // Only taxes still standing — one that staff already corrected on its
    // own must not be reversed a second time here.
    const taxesToReverse = isTaxLine
      ? []
      : (
          await tx.lineItem.findMany({
            where: { parentLineItemId: original.id, folioId: original.folioId, chargeType: 'tax', isVoid: false, deletedAt: null },
            include: { correctedBy: { select: { id: true } } },
          })
        ).filter((tax) => !tax.correctedBy);
    const reversedTaxTotal = taxesToReverse.reduce((sum, tax) => sum.plus(tax.amount), ZERO);

    try {
      const correction = await tx.lineItem.create({
        data: {
          tenantId,
          folioId: original.folioId,
          description: `Correction — ${original.description} (${reason})`.slice(0, 300),
          amount: original.amount.negated(),
          // Display denormalisation, same as on any charge: the tax this
          // correction takes back, shown beside it on the staff folio.
          taxAmount: reversedTaxTotal.negated(),
          chargeType: isTaxLine ? 'tax' : 'correction',
          taxRuleIds: isTaxLine ? original.taxRuleIds : [],
          serviceDate: original.serviceDate,
          outletId: original.outletId,
          correctsLineItemId: original.id,
          postedBy: actorId,
        },
      });

      for (const tax of taxesToReverse) {
        await tx.lineItem.create({
          data: {
            tenantId,
            folioId: tax.folioId,
            description: `Correction — ${tax.description}`.slice(0, 300),
            amount: tax.amount.negated(),
            chargeType: 'tax',
            taxRuleIds: tax.taxRuleIds,
            serviceDate: tax.serviceDate,
            outletId: tax.outletId,
            parentLineItemId: correction.id,
            correctsLineItemId: tax.id,
            postedBy: actorId,
          },
        });
      }

      await this.audit(tx, tenantId, folio.branchId, actorId, 'line_item.corrected', correction.id, {
        originalLineItemId: lineItemId,
        reason,
        reversedTaxLineIds: taxesToReverse.map((tax) => tax.id),
      });
      return correction;
    } catch (err) {
      // Two staff correcting the same line at once: the unique index lets
      // only one through. The loser gets the same answer as the check above.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw this.alreadyCorrected();
      throw err;
    }
  }

  private alreadyCorrected(): ConflictException {
    return new ConflictException({ code: ErrorCode.CONFLICT, message: 'This line has already been corrected' });
  }

  /**
   * Creates an ADDITIONAL folio on a reservation (spec §4.5: "a reservation
   * can hold multiple folios — e.g. room charges → company folio,
   * incidentals → guest folio"). The primary folio is the one with a null
   * `label`; every extra one must be named, so the two are never
   * ambiguous in a list.
   */
  async createAdditionalFolio(tenantId: string, reservationId: string, label: string, actorId: string): Promise<Folio> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await tx.reservation.findFirst({ where: { id: reservationId, deletedAt: null } });
      if (!reservation) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Reservation not found' });
      }
      const folio = await tx.folio.create({
        data: {
          tenantId,
          branchId: reservation.branchId,
          reservationId,
          guestId: reservation.guestId,
          label,
          status: 'open',
          openedAt: new Date(),
        },
      });
      await this.audit(tx, tenantId, reservation.branchId, actorId, 'folio.opened', folio.id, { reservationId, label });
      return folio;
    });
  }

  /**
   * Moves selected line items to another folio on the same reservation,
   * recording a `FolioTransfer` as the audit trail (spec §5:
   * "`POST /folios/:folioId/split` — move selected line items to a new
   * folio").
   *
   * **Reassigning `folioId` is not a violation of the append-only rule.**
   * That rule is about money: "no UPDATE of amounts, no DELETE"
   * (§4.5). No amount changes here and the combined balance across both
   * folios is identical before and after — only which bill an existing,
   * unmodified charge belongs to. `FolioTransfer.lineItemIds` snapshots
   * exactly what moved, which is the shape the schema was built for.
   *
   * **Tax travels with its charge.** Tax lines record the charge they were
   * computed on (`parentLineItemId`), so moving a charge moves its tax lines
   * too, whether or not the caller listed them — previously they stayed put
   * unless selected by hand, leaving a charge on one bill and its VAT on
   * another. A linked tax line can't be moved without its charge. Tax lines
   * posted before the link existed have no parent and still move only when
   * selected, exactly as before.
   */
  async splitFolio(
    tenantId: string,
    sourceFolioId: string,
    dto: { targetFolioId: string; lineItemIds: string[]; reason: string },
    actorId: string,
  ) {
    if (sourceFolioId === dto.targetFolioId) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Source and target folio must be different' });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const source = await this.findFolioOrThrow(tx, sourceFolioId);
      const target = await this.findFolioOrThrow(tx, dto.targetFolioId);
      this.assertFolioOpen(source);
      this.assertFolioOpen(target);

      // Both folios must belong to the same reservation — moving a charge
      // onto an unrelated guest's bill is a `transfer`, a separate
      // manager-approved operation (deferred), not a split.
      if (source.reservationId !== target.reservationId) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Both folios must belong to the same reservation',
        });
      }

      const selected = await tx.lineItem.findMany({
        where: { id: { in: dto.lineItemIds }, folioId: sourceFolioId, isVoid: false, deletedAt: null },
      });
      if (selected.length !== dto.lineItemIds.length) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: 'One or more line items do not belong to this folio, or are voided',
        });
      }

      const selectedIds = new Set(selected.map((item) => item.id));
      const strandedTax = selected.some((item) => item.chargeType === 'tax' && item.parentLineItemId && !selectedIds.has(item.parentLineItemId));
      if (strandedTax) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: 'A tax line moves with the charge it belongs to — select the charge instead',
        });
      }

      const linkedTax = await tx.lineItem.findMany({
        where: { parentLineItemId: { in: [...selectedIds] }, folioId: sourceFolioId, chargeType: 'tax', isVoid: false, deletedAt: null },
      });
      const toMove = [...selected, ...linkedTax.filter((tax) => !selectedIds.has(tax.id))];
      const movedIds = toMove.map((item) => item.id);

      const amount = toMove.reduce((sum, item) => sum.plus(item.amount), ZERO);
      await tx.lineItem.updateMany({ where: { id: { in: movedIds } }, data: { folioId: dto.targetFolioId } });

      const transfer = await tx.folioTransfer.create({
        data: {
          tenantId,
          sourceFolioId,
          targetFolioId: dto.targetFolioId,
          // What actually moved, including tax that came along with its
          // charge — the transfer record must match the ledger, not the request.
          lineItemIds: movedIds,
          amount,
          reason: dto.reason,
          approvedBy: actorId,
        },
      });
      await this.audit(tx, tenantId, source.branchId, actorId, 'folio.split', sourceFolioId, {
        targetFolioId: dto.targetFolioId,
        lineItemCount: toMove.length,
        taxLinesMovedWithCharges: toMove.length - selected.length,
        amount: amount.toFixed(2),
        reason: dto.reason,
      });
      return transfer;
    });
  }

  /** Every transfer this folio was either the source or the target of (spec §5's `GET /folios/:folioId/transfer-history`). */
  async getTransferHistory(tenantId: string, folioId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.findFolioOrThrow(tx, folioId);
      return tx.folioTransfer.findMany({
        where: { OR: [{ sourceFolioId: folioId }, { targetFolioId: folioId }] },
        orderBy: { createdAt: 'desc' },
      });
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
  async settleIfFullyPaid(tx: TenantTx, folio: Folio, actorId: string | null, via: string): Promise<boolean> {
    const totals = await this.computeTotals(tx, folio.id);
    if (totals.balanceDue.greaterThan(0)) return false;
    await tx.folio.update({ where: { id: folio.id }, data: { status: 'settled', closedAt: new Date() } });
    await this.audit(tx, folio.tenantId, folio.branchId, actorId, 'folio.closed', folio.id, {
      balanceDue: totals.balanceDue.toFixed(2),
      via,
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
            // `null` on the primary folio; a split folio's own name ("Company"). Without it, every folio on a
            // reservation reads identically in a list — same guest, same room.
            label: folio.label,
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
        // `guestStatus === 'city_ledger'` (not just "balance>0 and checkOutDate
        // passed" alone) — a guest who's STILL checked in past their own
        // checkout date is a real problem, but it's the new Alerts module's
        // own "overdue checkout" category, not this one; without this guard
        // the same guest showed up in BOTH lists as two "different" alerts
        // for what front desk experiences as one issue (caught live, once
        // Alerts started aggregating across both).
        return rows.filter((r) => r.guestStatus === 'city_ledger' && r.reservation != null && r.reservation.checkOutDate < today);
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
   *
   * Every tax row records the charge it was computed on (`parentLineItemId`).
   * That link is what lets `correctLineItem` reverse a charge's tax along
   * with the charge, and `splitFolio` move tax together with its charge —
   * before it existed, both left tax stranded on the wrong bill.
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
      /** The POS outlet that sold it; absent for everything posted at the desk or by the system. */
      outletId?: string;
      /** `null` = system-posted (the scheduled night audit) or a guest acting for themselves — `postedBy`'s own convention. */
      actorId: string | null;
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
        outletId: input.outletId,
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
          outletId: input.outletId,
          parentLineItemId: parent.id,
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

  /**
   * A no-show who owes an unpaid penalty is a City Ledger receivable too —
   * arguably more so than a checked-out guest, since there's no ongoing
   * in-house relationship left at all. Missed originally (found live: a
   * real no-show penalty left `guestStatus: null` despite a positive
   * balance, invisible to anyone scanning the folio list for what's owed).
   * The same holds for an unpaid cancellation charge.
   */
  private deriveGuestStatus(reservationStatus: string | null, balanceDue: Prisma.Decimal): FolioGuestStatus {
    if (!balanceDue.greaterThan(0)) return null;
    if (reservationStatus === 'checked_out' || reservationStatus === 'no_show' || reservationStatus === 'cancelled') return 'city_ledger';
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
    userId: string | null,
    action: string,
    entityId: string,
    after?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: { tenantId, branchId, userId, action, entityType: 'folio', entityId, after },
    });
  }
}
