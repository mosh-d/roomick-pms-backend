import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AdjustmentType, ChargeType, Folio, FolioTransfer, LineItem, Payment, Prisma, Reservation } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { nightlyRateFor } from '../reservations/nightly-rates';
import { PropertyService } from '../property/property.service';
import { WebhookEventsService } from '../integrations/webhook-events.service';
import { describeRule, PricedCharge, TaxesService } from '../taxes/taxes.service';
import { CorrectLineItemDto, PostChargeDto, RecordPaymentDto } from './dto/folio.dto';

const ZERO = new Prisma.Decimal(0);

/** A transfer can be put back for a day (ref: "Reverse transfer button (manager, 24h window)"). */
const TRANSFER_REVERSAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Which charges move: the ones picked, or everything on the bill. */
export interface MoveChargesInput {
  targetFolioId: string;
  lineItemIds?: string[];
  transferAll?: boolean;
  reason: string;
}

/** Both ends of a transfer, named the way the desk knows them — whose bill, which room — and who moved it. */
const FOLIO_END = {
  select: {
    id: true,
    label: true,
    status: true,
    reservationId: true,
    guest: { select: { id: true, name: true } },
    reservation: { select: { id: true, confirmationNumber: true, room: { select: { number: true } } } },
  },
} as const;
const TRANSFER_INCLUDE = {
  sourceFolio: FOLIO_END,
  targetFolio: FOLIO_END,
  approvedByUser: { select: { id: true, name: true } },
  reversedByUser: { select: { id: true, name: true } },
} as const;

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
/** `refund_due` — the bill holds a credit: the guest is owed money, and the bill can't close until it goes back. */
export type FolioGuestStatus = 'in_house' | 'city_ledger' | 'refund_due' | null;

/**
 * `in_house` — open bills of guests currently checked in (what the front-desk
 * pages need for live balances, instead of every bill the branch ever had);
 * `refund_due` — bills with a credit owed to the guest.
 */
export type FolioListFilter = 'all' | 'outstanding' | 'overdue' | 'in_house' | 'refund_due';

/** The `all` list is paged; the others are already narrowed to open bills. */
export const FOLIO_LIST_LIMIT = 200;
export const FOLIO_LIST_MAX = 500;

@Injectable()
export class FoliosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    private readonly taxesService: TaxesService,
    private readonly webhookEvents: WebhookEventsService,
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
    // Looked up by the stay, not the bill: a night split onto a company
    // folio or transferred to another room's bill is still billed. Looking
    // on this folio alone billed every moved night again at check-out. A
    // room line with no stay recorded is one posted by hand, found where it
    // sits, as before.
    const already = await tx.lineItem.findFirst({
      where: {
        chargeType: 'room',
        serviceDate,
        isVoid: false,
        deletedAt: null,
        OR: [{ stayReservationId: reservation.id }, { stayReservationId: null, folioId: folio.id }],
      },
    });
    if (already) return null;
    const billTo = await this.routedFolio(tx, reservation, folio);

    const nights = Math.max(
      1,
      Math.round((reservation.checkOutDate.getTime() - reservation.checkInDate.getTime()) / 86_400_000),
    );
    // A pinned nightly rate (a manager's override, a room move) first; then
    // the night's own quoted price; the stay total split evenly only for a
    // stay booked before nights were kept — that split could leave the bill
    // a kobo off the quote and billed a 30,000 + 45,000 stay as 37,500 twice.
    const perNight = reservation.overrideRate
      ? new Prisma.Decimal(reservation.overrideRate)
      : (nightlyRateFor(reservation, serviceDate) ?? new Prisma.Decimal(reservation.confirmedRate).div(nights).toDecimalPlaces(2));

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
      folioId: billTo.id,
      description,
      amount: perNight,
      chargeType: 'room',
      serviceDate,
      stayReservationId: reservation.id,
      actorId,
    });
  }

  /**
   * Where a stay's room nights are billed: the bill they're routed to — a
   * group's master bill (`Reservation.billToFolioId`) — while it's open at
   * the same property, else the bill given. A master bill that's been
   * settled stops taking nights; they go back on the guest's own.
   */
  private async routedFolio(tx: TenantTx, reservation: Reservation, folio: Folio): Promise<Folio> {
    if (!reservation.billToFolioId || reservation.billToFolioId === folio.id) return folio;
    const routed = await tx.folio.findFirst({ where: { id: reservation.billToFolioId, deletedAt: null } });
    return routed && routed.status !== 'settled' && routed.branchId === reservation.branchId ? routed : folio;
  }

  /**
   * The same cross-service, in-transaction posting primitive
   * `postRoomChargeForDate` is, generalized for a caller that isn't posting
   * a room night — no-show and cancellation penalties. Charges only: taking
   * one back is `reverseChargeInTx`, which reverses exactly the tax that was
   * posted with it.
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

  /** What `writeChargeWithTaxes` would post for a price — for quoting a charge (a cancellation charge, a POS basket) before it's posted. Same rules, same rounding, nothing written. */
  async previewCharge(tx: TenantTx, branchId: string, chargeType: ChargeType, price: Prisma.Decimal): Promise<PricedCharge> {
    return this.taxesService.priceCharge(tx, branchId, chargeType, price);
  }

  /** What each reservation's primary bill stands at — for lists that show a stay's balance beside it (Alerts' overdue checkouts). Read-only; a stay with no bill yet is left out. */
  async primaryFolioBalances(tx: TenantTx, reservationIds: string[]): Promise<Map<string, { folioId: string; balanceDue: Prisma.Decimal }>> {
    const balances = new Map<string, { folioId: string; balanceDue: Prisma.Decimal }>();
    if (reservationIds.length === 0) return balances;
    const folios = await tx.folio.findMany({ where: { reservationId: { in: reservationIds }, label: null, deletedAt: null }, select: { id: true, reservationId: true } });
    for (const folio of folios) {
      if (!folio.reservationId) continue;
      balances.set(folio.reservationId, { folioId: folio.id, balanceDue: (await this.computeTotals(tx, folio.id)).balanceDue });
    }
    return balances;
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
      // Cash has to land in a drawer that's counted at close. Without an open
      // shift it was recorded against nothing and never reconciled — a cash
      // payment taken before the shift opened simply vanished from the count.
      if (dto.method === 'cash' && !openShift) throw this.shiftRequired();

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

  shiftRequired(): ConflictException {
    return new ConflictException({ code: ErrorCode.SHIFT_REQUIRED, message: 'Open a shift before taking cash — it has to go into a drawer that gets counted at close' });
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
    const correction = await this.reverseLineItem(tx, tenantId, original, folio, reason, actorId);
    // A charge rung up at an outlet is that outlet's sale too. Taken back
    // here, the outlet's own list still showed the sale as standing; now it
    // shows it voided, as voiding it at the outlet would. (Voiding at the
    // outlet claims the order first and then comes through here — the
    // update below then finds nothing left to do.)
    await tx.posOrder.updateMany({
      where: { lineItemId: original.id, voidedAt: null },
      data: { voidedAt: new Date(), voidedBy: actorId, voidReason: `Taken off the guest's bill: ${reason}`.slice(0, 500) },
    });
    return correction;
  }

  /**
   * Takes back a charge the system posted, with exactly the tax posted with
   * it — waiving a no-show penalty. Unlike a correction from the desk this
   * works on a settled bill too: waiving a penalty that was already paid
   * leaves the guest in credit, which is the point. `null` when the charge
   * was already taken back.
   */
  async reverseChargeInTx(tx: TenantTx, tenantId: string, lineItemId: string, reason: string, actorId: string | null): Promise<LineItem | null> {
    const original = await tx.lineItem.findFirst({ where: { id: lineItemId, deletedAt: null, isVoid: false } });
    if (!original) return null;
    const reversed = await tx.lineItem.findFirst({ where: { correctsLineItemId: original.id }, select: { id: true } });
    if (reversed) return null;
    const folio = await this.findFolioOrThrow(tx, original.folioId);
    return this.reverseLineItem(tx, tenantId, original, folio, reason, actorId);
  }

  private async reverseLineItem(tx: TenantTx, tenantId: string, original: LineItem, folio: Folio, reason: string, actorId: string | null): Promise<LineItem> {
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
        originalLineItemId: original.id,
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
   * ambiguous in a list. It can name who pays it, and the company it's
   * billed to.
   */
  async createAdditionalFolio(
    tenantId: string,
    reservationId: string,
    input: { label: string; payerName?: string; corporateAccountId?: string },
    actorId: string,
  ): Promise<Folio> {
    return this.prisma.withTenant(tenantId, (tx) => this.createAdditionalFolioInTx(tx, tenantId, reservationId, input, actorId));
  }

  /** `createAdditionalFolio` inside a caller's transaction — group check-in opens the group's master bill through here. */
  async createAdditionalFolioInTx(
    tx: TenantTx,
    tenantId: string,
    reservationId: string,
    input: { label: string; payerName?: string; corporateAccountId?: string },
    actorId: string,
  ): Promise<Folio> {
    const reservation = await tx.reservation.findFirst({ where: { id: reservationId, deletedAt: null } });
    if (!reservation) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Reservation not found' });
    }
    if (input.corporateAccountId) {
      const account = await tx.corporateAccount.findFirst({ where: { id: input.corporateAccountId, isActive: true }, select: { id: true } });
      if (!account) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'That company account is not active — pick another, or leave it blank' });
      }
    }
    const folio = await tx.folio.create({
      data: {
        tenantId,
        branchId: reservation.branchId,
        reservationId,
        guestId: reservation.guestId,
        label: input.label.trim(),
        payerName: input.payerName?.trim() || null,
        corporateAccountId: input.corporateAccountId ?? null,
        status: 'open',
        openedAt: new Date(),
      },
    });
    await this.audit(tx, tenantId, reservation.branchId, actorId, 'folio.opened', folio.id, {
      reservationId,
      label: folio.label,
      ...(folio.payerName ? { payerName: folio.payerName } : {}),
      ...(folio.corporateAccountId ? { corporateAccountId: folio.corporateAccountId } : {}),
    });
    return folio;
  }

  /**
   * Moves selected line items to another folio on the same reservation —
   * Split Billing (spec §5: "`POST /folios/:folioId/split` — move selected
   * line items to a new folio"). The front desk's move: it never changes
   * who the stay owes, only which of its bills a charge sits on.
   */
  async splitFolio(tenantId: string, sourceFolioId: string, dto: MoveChargesInput, actorId: string): Promise<FolioTransfer> {
    return this.moveCharges(tenantId, sourceFolioId, dto, actorId, 'split');
  }

  /**
   * Folio Transfer (ref: "Move individual charges or entire folio balances
   * between folios mid-stay") — onto any open bill at the property: room
   * to room, a guest's charges to a company's bill. Moving a charge onto
   * someone else's bill is the manager's call (the route's roles); within
   * one stay it's the same move Split Billing makes.
   */
  async transferCharges(tenantId: string, sourceFolioId: string, dto: MoveChargesInput, actorId: string): Promise<FolioTransfer> {
    return this.moveCharges(tenantId, sourceFolioId, dto, actorId, 'transfer');
  }

  /**
   * **Reassigning `folioId` is not a violation of the append-only rule.**
   * That rule is about money: "no UPDATE of amounts, no DELETE"
   * (§4.5). No amount changes here and the combined balance across both
   * folios is identical before and after — only which bill an existing,
   * unmodified charge belongs to. `FolioTransfer.lineItemIds` snapshots
   * exactly what moved, which is the shape the schema was built for.
   *
   * **A charge moves with everything hanging off it** — its tax lines
   * (`parentLineItemId`), its correction (`correctsLineItemId`) and the
   * correction's own tax reversals — whether or not the caller listed them.
   * Tax used to stay put unless selected by hand, leaving a charge on one
   * bill and its VAT on another, and a correction stayed behind as a credit
   * on the wrong bill. A tax line or correction can't be moved without its
   * charge. Lines posted before those links existed have none and move only
   * when selected, exactly as before.
   *
   * A room night keeps its stay (`stayReservationId`) wherever it goes, so
   * check-out never bills it again; a Point of Sale order charged to a room
   * follows its charge to the new bill.
   */
  private async moveCharges(tenantId: string, sourceFolioId: string, dto: MoveChargesInput, actorId: string, kind: 'split' | 'transfer'): Promise<FolioTransfer> {
    if (sourceFolioId === dto.targetFolioId) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Source and target folio must be different' });
    }
    const requestedIds = dto.lineItemIds ?? [];
    if (!dto.transferAll && requestedIds.length === 0) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Pick the charges to move, or move them all' });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const source = await this.findFolioOrThrow(tx, sourceFolioId);
      const target = await this.findFolioOrThrow(tx, dto.targetFolioId);
      this.assertFolioOpen(source);
      this.assertFolioOpen(target);

      if (source.branchId !== target.branchId) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Charges can only move between bills at the same property' });
      }
      const sameStay = source.reservationId === target.reservationId;
      if (kind === 'split' && !sameStay) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: "Both folios must belong to the same reservation — moving charges onto another stay's bill is a Folio Transfer",
        });
      }

      const selected = dto.transferAll
        ? await tx.lineItem.findMany({ where: { folioId: sourceFolioId, isVoid: false, deletedAt: null }, orderBy: { postedAt: 'asc' } })
        : await tx.lineItem.findMany({ where: { id: { in: requestedIds }, folioId: sourceFolioId, isVoid: false, deletedAt: null } });
      if (dto.transferAll && selected.length === 0) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'This bill has no charges to move' });
      }
      if (!dto.transferAll && selected.length !== requestedIds.length) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: 'One or more line items do not belong to this folio, or are voided',
        });
      }

      const toMove = await this.withDependents(tx, sourceFolioId, selected);
      const moving = new Set(toMove.map((item) => item.id));
      const stranded = selected.some((item) => {
        const anchor = this.anchorOf(item);
        return anchor !== null && !moving.has(anchor);
      });
      if (stranded) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: 'A tax line or correction moves with the charge it belongs to — select the charge instead',
        });
      }
      const movedIds = toMove.map((item) => item.id);

      const amount = toMove.reduce((sum, item) => sum.plus(item.amount), ZERO);
      await tx.lineItem.updateMany({ where: { id: { in: movedIds } }, data: { folioId: dto.targetFolioId } });
      await tx.posOrder.updateMany({ where: { lineItemId: { in: movedIds } }, data: { folioId: dto.targetFolioId } });

      const transfer = await tx.folioTransfer.create({
        data: {
          tenantId,
          sourceFolioId,
          targetFolioId: dto.targetFolioId,
          // What actually moved, including what came along with its charge —
          // the transfer record must match the ledger, not the request.
          lineItemIds: movedIds,
          amount,
          reason: dto.reason,
          approvedBy: actorId,
        },
      });
      await this.audit(tx, tenantId, source.branchId, actorId, kind === 'split' ? 'folio.split' : 'folio.transferred', sourceFolioId, {
        targetFolioId: dto.targetFolioId,
        ...(sameStay ? {} : { fromReservationId: source.reservationId, toReservationId: target.reservationId }),
        ...(dto.transferAll ? { transferAll: true } : {}),
        lineItemCount: toMove.length,
        movedWithTheirCharges: toMove.length - selected.length,
        amount: amount.toFixed(2),
        reason: dto.reason,
      });
      return transfer;
    });
  }

  /**
   * Puts a transfer back (ref: "Reverse transfer button (manager, 24h
   * window)"): the same charges return to the bill they came from. After a
   * day, or once one of them has moved on again or a bill is settled, it's
   * a new transfer instead — a reversal must never pull a charge off a bill
   * it has since been paid on or moved from.
   */
  async reverseTransfer(tenantId: string, transferId: string, actorId: string): Promise<FolioTransfer> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const transfer = await tx.folioTransfer.findFirst({ where: { id: transferId } });
      if (!transfer) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Transfer not found' });
      }
      if (transfer.reversedAt) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This transfer has already been reversed' });
      }
      if (Date.now() - transfer.createdAt.getTime() > TRANSFER_REVERSAL_WINDOW_MS) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'A transfer can be reversed within 24 hours — after that, move the charges back with a new transfer',
        });
      }
      const source = await this.findFolioOrThrow(tx, transfer.sourceFolioId);
      const target = await this.findFolioOrThrow(tx, transfer.targetFolioId);
      this.assertFolioOpen(source);
      this.assertFolioOpen(target);

      const moved = await tx.lineItem.findMany({ where: { id: { in: transfer.lineItemIds } } });
      if (moved.some((item) => item.folioId !== transfer.targetFolioId)) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'Some of these charges have moved to another bill since — reverse that move first',
        });
      }
      // Anything posted against them since (a correction, its tax) goes back with them.
      const toReturn = await this.withDependents(tx, transfer.targetFolioId, moved);
      const returnIds = toReturn.map((item) => item.id);
      await tx.lineItem.updateMany({ where: { id: { in: returnIds } }, data: { folioId: transfer.sourceFolioId } });
      await tx.posOrder.updateMany({ where: { lineItemId: { in: returnIds } }, data: { folioId: transfer.sourceFolioId } });

      const reversed = await tx.folioTransfer.update({ where: { id: transferId }, data: { reversedAt: new Date(), reversedBy: actorId } });
      await this.audit(tx, tenantId, source.branchId, actorId, 'folio.transfer_reversed', transfer.sourceFolioId, {
        transferId,
        fromFolioId: transfer.targetFolioId,
        lineItemCount: returnIds.length,
        amount: toReturn.reduce((sum, item) => sum.plus(item.amount), ZERO).toFixed(2),
      });
      return reversed;
    });
  }

  /** Every transfer this folio was either the source or the target of (spec §5's `GET /folios/:folioId/transfer-history`), newest first. */
  async getTransferHistory(tenantId: string, folioId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.findFolioOrThrow(tx, folioId);
      return tx.folioTransfer.findMany({
        where: { OR: [{ sourceFolioId: folioId }, { targetFolioId: folioId }] },
        include: TRANSFER_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
    });
  }

  /** Transfer History (ref: "Full audit trail of all folio movements") — every move at the branch in a date range, newest first. */
  async listBranchTransfers(tenantId: string, branchId: string, range: { from?: string; to?: string }) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const createdAt: Prisma.DateTimeFilter = {};
      if (range.from) createdAt.gte = new Date(`${range.from}T00:00:00.000Z`);
      if (range.to) createdAt.lt = new Date(new Date(`${range.to}T00:00:00.000Z`).getTime() + 86_400_000);
      const transfers = await tx.folioTransfer.findMany({
        where: { sourceFolio: { branchId }, ...(range.from || range.to ? { createdAt } : {}) },
        include: TRANSFER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      // The branch's ISO 4217 code with the money, as on every folio response.
      return transfers.map((transfer) => ({ ...transfer, currency: branch.currency }));
    });
  }

  /** `items` plus every line on `folioId` hanging off them — tax lines, corrections, a correction's tax reversals — in the order found. */
  private async withDependents(tx: TenantTx, folioId: string, items: LineItem[]): Promise<LineItem[]> {
    const result = [...items];
    const seen = new Set(items.map((item) => item.id));
    let frontier = [...seen];
    while (frontier.length > 0) {
      const found = await tx.lineItem.findMany({
        where: {
          folioId,
          isVoid: false,
          deletedAt: null,
          OR: [{ parentLineItemId: { in: frontier } }, { correctsLineItemId: { in: frontier } }],
        },
      });
      frontier = [];
      for (const item of found) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        result.push(item);
        frontier.push(item.id);
      }
    }
    return result;
  }

  /** The line a tax line or correction belongs to — it can only move with it. `null` for a charge, and for lines posted before the links existed. */
  private anchorOf(item: LineItem): string | null {
    if (item.chargeType === 'tax' && item.parentLineItemId) return item.parentLineItemId;
    return item.correctsLineItemId ?? null;
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
      // A credit is money owed to the guest. Closing over it made the credit
      // vanish from every outstanding list — refund it or move it first.
      if (totals.balanceDue.lessThan(0)) {
        throw new ConflictException({
          code: ErrorCode.FOLIO_CREDIT_BALANCE,
          message: `The guest is owed ${totals.balanceDue.negated().toFixed(2)} on this bill — refund it, or transfer it to another bill, before closing`,
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

  /**
   * A settled bill opened again for something found after it closed — the
   * minibar after check-out, a charge on the wrong night. A supervisor's call
   * (the route says so), with the reason in the audit trail. Posting to a
   * settled bill has always said "reopen it first", and there was no way to.
   */
  async reopenFolio(tenantId: string, folioId: string, reason: string, actorId: string): Promise<Folio> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const folio = await this.findFolioOrThrow(tx, folioId);
      const { count } = await tx.folio.updateMany({ where: { id: folioId, status: 'settled' }, data: { status: 'open', closedAt: null } });
      if (count === 0) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This bill is already open' });
      }
      await this.audit(tx, tenantId, folio.branchId, actorId, 'folio.reopened', folioId, { reason: reason.trim() });
      return tx.folio.findUniqueOrThrow({ where: { id: folioId } });
    });
  }

  /** Settles a folio if it is fully paid, WITHOUT throwing when it isn't — the check-out path (which must never block). Returns whether it settled. */
  async settleIfFullyPaid(tx: TenantTx, folio: Folio, actorId: string | null, via: string): Promise<boolean> {
    const totals = await this.computeTotals(tx, folio.id);
    // Exactly zero: a bill the guest still owes on, or is owed on, stays open.
    if (!totals.balanceDue.isZero()) return false;
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

      // A fixed rule's base can't be worked back from what it collected (the
      // amount doesn't depend on the charge), so it's the charges themselves:
      // the parent line of each of its tax lines.
      const parentIds = [...new Set(taxItems.map((item) => item.parentLineItemId).filter((id): id is string => id !== null))];
      const parents = parentIds.length ? await tx.lineItem.findMany({ where: { id: { in: parentIds } }, select: { id: true, amount: true } }) : [];
      const parentAmount = new Map(parents.map((p) => [p.id, p.amount]));

      type Row = {
        ruleId: string;
        ruleName: string;
        type: AdjustmentType;
        rate: Prisma.Decimal;
        fixedAmount: Prisma.Decimal | null;
        inclusive: boolean;
        taxCollected: Prisma.Decimal;
        chargedBase: Prisma.Decimal;
      };
      const grouped = new Map<string, Row>();

      for (const item of taxItems) {
        const ruleId = item.taxRuleIds[0];
        if (!ruleId) continue;
        const rule = ruleById.get(ruleId);
        const entry = grouped.get(ruleId) ?? {
          ruleId,
          ruleName: rule?.name ?? 'Unknown rule',
          type: rule?.type ?? 'percentage',
          rate: rule?.rate ?? ZERO,
          fixedAmount: rule?.fixedAmount ?? null,
          inclusive: rule?.inclusive ?? false,
          taxCollected: ZERO,
          chargedBase: ZERO,
        };
        entry.taxCollected = entry.taxCollected.plus(item.amount);
        // A correction's reversing tax line hangs off the correction line,
        // whose amount is already negative — so a reversed charge nets out of
        // the base on its own, with no sign juggling here.
        const base = item.parentLineItemId ? parentAmount.get(item.parentLineItemId) : undefined;
        if (base) entry.chargedBase = entry.chargedBase.plus(base);
        grouped.set(ruleId, entry);
      }

      const rows = [...grouped.values()].map(({ chargedBase, ...entry }) => ({
        ...entry,
        // Percentage rules: reverse out the base this rule actually taxed,
        // rather than re-deriving it from line items — the collected amount is
        // the fact that was recorded. Fixed rules: the charges themselves.
        taxableBase:
          entry.type === 'fixed' ? chargedBase.toDecimalPlaces(2) : entry.rate.isZero() ? ZERO : entry.taxCollected.div(entry.rate).toDecimalPlaces(2),
      }));
      const totalTax = rows.reduce((sum, r) => sum.plus(r.taxCollected), ZERO);
      return { rows, totalTax };
    });
  }

  /** A stay's bills, primary first, each with what it owes and the company it goes to — the folio tabs on a reservation. */
  async listFoliosForReservation(tenantId: string, reservationId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const folios = await tx.folio.findMany({
        where: { reservationId, deletedAt: null },
        include: { corporateAccount: { select: { id: true, name: true } } },
        orderBy: { openedAt: 'asc' },
      });
      return Promise.all(folios.map(async (folio) => ({ ...folio, balanceDue: (await this.computeTotals(tx, folio.id)).balanceDue })));
    });
  }

  /**
   * Branch folio list with the in-house PMS's own filter vocabulary:
   * "outstanding" = open with a balance owed; "overdue" = outstanding AND
   * the guest's check-out date has already passed (i.e. a City Ledger
   * receivable) — `PMS-OPERATIONS-GUIDE.md:221`.
   */
  async listFolios(tenantId: string, branchId: string, filter: FolioListFilter, page: { limit?: number; offset?: number } = {}) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const take = Math.min(Math.max(page.limit ?? FOLIO_LIST_LIMIT, 1), FOLIO_LIST_MAX);
      const folios = await tx.folio.findMany({
        where: {
          branchId,
          deletedAt: null,
          ...(filter === 'all' ? {} : { status: { not: 'settled' } }),
          ...(filter === 'in_house' ? { reservation: { is: { status: 'checked_in', deletedAt: null } } } : {}),
        },
        include: {
          guest: { select: { id: true, name: true } },
          reservation: {
            select: { id: true, confirmationNumber: true, status: true, checkOutDate: true, room: { select: { number: true } } },
          },
        },
        orderBy: { openedAt: 'desc' },
        ...(filter === 'all' ? { take, skip: Math.max(page.offset ?? 0, 0) } : {}),
      });

      // Every balance from two grouped sums, not a pair of queries per bill —
      // the old loop re-read every line item and payment the branch ever had.
      const balances = await this.balancesFor(tx, folios.map((f) => f.id));
      const today = toBranchDate(todayInTimezone(branch.timezone));
      const rows = folios.map((folio) => {
        const balanceDue = balances.get(folio.id) ?? ZERO;
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
          balanceDue,
          currency: branch.currency,
          guestStatus: this.deriveGuestStatus(folio.reservation?.status ?? null, balanceDue),
        };
      });

      if (filter === 'outstanding') return rows.filter((r) => r.balanceDue.greaterThan(0));
      if (filter === 'refund_due') return rows.filter((r) => r.balanceDue.lessThan(0));
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
      /** Room nights only: the stay the night is for — see `LineItem.stayReservationId`. */
      stayReservationId?: string;
      /** `null` = system-posted (the scheduled night audit) or a guest acting for themselves — `postedBy`'s own convention. */
      actorId: string | null;
    },
  ): Promise<LineItem | null> {
    if (input.amount.isZero()) return null;
    // Credits are reversals of something specific — `reverseLineItem` takes
    // back a charge and exactly the tax posted with it. Re-running the tax
    // rules on a negative amount would reverse at today's rules instead.
    if (input.amount.isNegative()) throw new Error('A credit is a reversal of a posted charge — use correctLineItem / reverseChargeInTx');

    // `amount` is the price as entered; any tax the branch includes in its
    // prices comes out of it, so the charge line carries the net.
    const priced = await this.taxesService.priceCharge(tx, input.branchId, input.chargeType, input.amount);

    const parent = await tx.lineItem.create({
      data: {
        tenantId: input.tenantId,
        folioId: input.folioId,
        description: input.description,
        amount: priced.net,
        taxAmount: priced.taxTotal,
        chargeType: input.chargeType,
        serviceDate: input.serviceDate,
        outletId: input.outletId,
        stayReservationId: input.stayReservationId,
        postedBy: input.actorId,
      },
    });

    for (const tax of priced.taxes) {
      await tx.lineItem.create({
        data: {
          tenantId: input.tenantId,
          folioId: input.folioId,
          description: `${describeRule({ name: tax.ruleName, type: tax.type, rate: tax.rate, fixedAmount: tax.fixedAmount, inclusive: tax.inclusive })} — ${input.description}`.slice(0, 300),
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
      amount: priced.net.toFixed(2),
      taxAmount: priced.taxTotal.toFixed(2),
      ...(priced.includedTax.isZero() ? {} : { price: input.amount.toFixed(2), taxIncluded: priced.includedTax.toFixed(2) }),
    });
    return parent;
  }

  /** A folio's totals inside the caller's transaction — what Refunds checks a bill's credit against. */
  async totalsInTx(tx: TenantTx, folioId: string): Promise<FolioTotals> {
    return this.computeTotals(tx, folioId);
  }

  /** `balance = SUM(line_items not void/deleted) − SUM(payments not void)` — computed, never stored (spec §4.5). */
  /** Each bill's balance — charges (tax rows included) less payments — in two grouped sums for any number of bills. */
  private async balancesFor(tx: TenantTx, folioIds: string[]): Promise<Map<string, Prisma.Decimal>> {
    const balances = new Map<string, Prisma.Decimal>(folioIds.map((id) => [id, ZERO]));
    if (folioIds.length === 0) return balances;
    const [charges, payments] = await Promise.all([
      tx.lineItem.groupBy({ by: ['folioId'], where: { folioId: { in: folioIds }, isVoid: false, deletedAt: null }, _sum: { amount: true } }),
      tx.payment.groupBy({ by: ['folioId'], where: { folioId: { in: folioIds }, isVoid: false, deletedAt: null }, _sum: { amount: true } }),
    ]);
    for (const row of charges) balances.set(row.folioId, (balances.get(row.folioId) ?? ZERO).plus(row._sum.amount ?? ZERO));
    for (const row of payments) balances.set(row.folioId, (balances.get(row.folioId) ?? ZERO).minus(row._sum.amount ?? ZERO));
    return balances;
  }

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
    if (balanceDue.lessThan(0)) return 'refund_due';
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
    // Every payment taken on a bill is recorded here — loyalty points too.
    if (action === 'payment.recorded') await this.webhookEvents.paymentRecorded(tx, { tenantId, branchId, type: 'payment.received', paymentId: entityId });
  }
}
