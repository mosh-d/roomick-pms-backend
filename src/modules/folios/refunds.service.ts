import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Refund, RefundStatus } from '@prisma/client';
import { SystemRole } from '../../common/decorators/roles.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { hasRoleAtBranch } from '../../common/utils/branch-roles';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { WebhookEventsService } from '../integrations/webhook-events.service';
import { PropertyService } from '../property/property.service';
import { REFUND_METHODS, RefundMethod, RequestRefundDto } from './dto/refund.dto';
import { FoliosService } from './folios.service';

const ZERO = new Prisma.Decimal(0);

/** Who approves a refund — and whose own request needs no one else's. */
const APPROVER_ROLES = [SystemRole.Owner, SystemRole.Manager];

/** Refunds still to come off a bill's credit: asked for, or approved and not yet handed over. */
const OUTSTANDING: RefundStatus[] = ['pending', 'approved'];

const REFUND_INCLUDE = {
  folio: {
    select: {
      id: true,
      label: true,
      branchId: true,
      guest: { select: { id: true, name: true } },
      reservation: { select: { id: true, confirmationNumber: true, room: { select: { number: true } } } },
    },
  },
  payment: { select: { id: true, method: true, amount: true, recordedAt: true, reference: true } },
  requestedByUser: { select: { id: true, name: true } },
  approvedByUser: { select: { id: true, name: true } },
  processedByUser: { select: { id: true, name: true } },
} as const;

/**
 * Refunds & Corrections (ref: "Process refunds with approval workflow") —
 * money going back to a guest. A charge that shouldn't be on the bill is a
 * correction (`FoliosService.correctLineItem`); what the guest is then owed
 * back is a refund, and it moves through three steps:
 *
 * 1. **Requested** by the desk, up to what the bill holds in credit (paid
 *    more than it owes) less refunds already on their way — never more
 *    than the guest is owed.
 * 2. **Approved** (or turned down) by a manager — the reference's "Manager
 *    approval gate". A manager's or owner's own request needs no second
 *    approval: they are the gate.
 * 3. **Paid out** by whoever hands the money over, as a negative payment by
 *    the refund's method. Cash comes out of that person's open drawer, so
 *    the shift's count still adds up.
 *
 * The credit is checked again at each step: a bill can change between the
 * request and the payout, and a refund must never leave the guest owing.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foliosService: FoliosService,
    private readonly propertyService: PropertyService,
    private readonly webhookEvents: WebhookEventsService,
  ) {}

  async request(tenantId: string, folioId: string, dto: RequestRefundDto, actor: JwtPayload): Promise<Refund> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const folio = await tx.folio.findFirst({ where: { id: folioId, deletedAt: null } });
      if (!folio) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Folio not found' });
      return this.requestInTx(tx, tenantId, folio, dto, actor);
    });
  }

  /**
   * The request itself, inside a caller's transaction — walking a guest
   * raises the refund of what they paid in the same transaction that walks
   * them, through this workflow (approval, and the cash-shift rule at
   * pay-out) rather than as reversal rows written straight into the ledger.
   */
  async requestInTx(tx: TenantTx, tenantId: string, folio: { id: string; branchId: string }, dto: RequestRefundDto, actor: JwtPayload): Promise<Refund> {
    const folioId = folio.id;
    {
      const payment = dto.paymentId ? await tx.payment.findFirst({ where: { id: dto.paymentId, folioId, isVoid: false, deletedAt: null } }) : null;
      if (dto.paymentId && (!payment || !payment.amount.greaterThan(0))) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'That payment is not one made to this bill' });
      }
      const method = dto.method ?? payment?.method;
      if (!method) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Say how the money goes back — cash, card or bank transfer' });
      }
      if (!(REFUND_METHODS as readonly string[]).includes(method)) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: "Points go back as an adjustment on the guest's loyalty page, and a voucher isn't refunded as money — pick cash, card or bank transfer",
        });
      }

      const amount = new Prisma.Decimal(dto.amount);
      const { credit, available } = await this.refundable(tx, folioId);
      if (amount.greaterThan(available)) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: available.greaterThan(0)
            ? `Only ${available.toFixed(2)} on this bill is the guest's to refund`
            : credit.greaterThan(0)
              ? "All of this bill's credit already has a refund on its way"
              : 'This bill holds no credit to refund — the guest has not paid more than they owe',
        });
      }
      if (payment) {
        const left = payment.amount.minus(await this.refundedAgainst(tx, payment.id));
        if (amount.greaterThan(left)) {
          throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `That payment has only ${left.toFixed(2)} left to refund` });
        }
      }

      const selfApproved = hasRoleAtBranch(actor, folio.branchId, APPROVER_ROLES);
      const refund = await tx.refund.create({
        data: {
          tenantId,
          folioId,
          paymentId: payment?.id ?? null,
          amount,
          reason: dto.reason.trim(),
          method: method as RefundMethod,
          status: selfApproved ? 'approved' : 'pending',
          requestedBy: actor.sub,
          approvedBy: selfApproved ? actor.sub : null,
        },
      });
      await this.audit(tx, tenantId, folio.branchId, actor.sub, 'refund.requested', refund.id, {
        folioId,
        amount: amount.toFixed(2),
        method,
        reason: refund.reason,
        ...(payment ? { paymentId: payment.id } : {}),
        ...(selfApproved ? { approvedOnRequest: true } : {}),
      });
      return refund;
    }
  }

  async approve(tenantId: string, refundId: string, actor: JwtPayload): Promise<Refund> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const refund = await this.findOrThrow(tx, refundId);
      if (refund.status !== 'pending') {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: `This refund is ${refund.status}, not waiting for approval` });
      }
      const { available } = await this.refundable(tx, refund.folioId, refund.id);
      if (refund.amount.greaterThan(available)) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: `The bill has changed since this was asked for — only ${available.toFixed(2)} can be refunded now. Turn this one down and ask again.`,
        });
      }
      const approved = await tx.refund.update({ where: { id: refundId }, data: { status: 'approved', approvedBy: actor.sub } });
      await this.audit(tx, tenantId, refund.folio.branchId, actor.sub, 'refund.approved', refundId, { amount: refund.amount.toFixed(2) });
      return approved;
    });
  }

  /** Turned down — while waiting, or approved and not yet handed over. Money already paid out can't be un-refunded here. */
  async reject(tenantId: string, refundId: string, reason: string, actor: JwtPayload): Promise<Refund> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const refund = await this.findOrThrow(tx, refundId);
      if (!OUTSTANDING.includes(refund.status)) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: `This refund is already ${refund.status}` });
      }
      const rejected = await tx.refund.update({ where: { id: refundId }, data: { status: 'rejected', rejectionReason: reason.trim() } });
      await this.audit(tx, tenantId, refund.folio.branchId, actor.sub, 'refund.rejected', refundId, { amount: refund.amount.toFixed(2), reason: reason.trim() });
      return rejected;
    });
  }

  async payOut(tenantId: string, refundId: string, actor: JwtPayload): Promise<Refund> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const refund = await this.findOrThrow(tx, refundId);
      if (refund.status !== 'approved') {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: refund.status === 'pending' ? 'A manager has to approve this refund before it is paid out' : `This refund is ${refund.status}`,
        });
      }
      const credit = (await this.foliosService.totalsInTx(tx, refund.folioId)).balanceDue.negated();
      if (refund.amount.greaterThan(credit)) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: `The bill holds only ${Prisma.Decimal.max(credit, ZERO).toFixed(2)} in credit now — turn this refund down and ask again`,
        });
      }
      const branch = await this.propertyService.assertBranch(tx, refund.folio.branchId);
      // Cash leaves the drawer of whoever hands it over — their open shift, as with any cash payment.
      const openShift =
        refund.method === 'cash' ? await tx.shift.findFirst({ where: { branchId: refund.folio.branchId, agentId: actor.sub, closedAt: null } }) : null;
      if (refund.method === 'cash' && !openShift) throw this.foliosService.shiftRequired();
      const payment = await tx.payment.create({
        data: {
          tenantId,
          folioId: refund.folioId,
          method: refund.method,
          amount: refund.amount.negated(),
          currency: branch.currency,
          reference: `Refund — ${refund.reason}`.slice(0, 100),
          shiftId: openShift?.id,
          recordedBy: actor.sub,
        },
      });
      const paid = await tx.refund.update({
        where: { id: refundId },
        data: { status: 'processed', processedAt: new Date(), processedBy: actor.sub, refundPaymentId: payment.id },
      });
      await this.audit(tx, tenantId, refund.folio.branchId, actor.sub, 'refund.paid_out', refundId, {
        amount: refund.amount.toFixed(2),
        method: refund.method,
        paymentId: payment.id,
        ...(openShift ? { shiftId: openShift.id } : {}),
      });
      await this.webhookEvents.paymentRecorded(tx, { tenantId, branchId: refund.folio.branchId, type: 'refund.paid', paymentId: payment.id, refundId });
      return paid;
    });
  }

  async listForBranch(tenantId: string, branchId: string, status?: RefundStatus) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const refunds = await tx.refund.findMany({
        where: { folio: { branchId }, ...(status ? { status } : {}) },
        include: REFUND_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 300,
      });
      return refunds.map((refund) => ({ ...refund, currency: branch.currency }));
    });
  }

  /** A bill's credit, and what of it can be refunded now: less refunds already asked for or approved (other than `exceptId`). */
  /** What a bill holds for the guest: its credit, and how much of that no refund is already on its way for. */
  async refundable(tx: TenantTx, folioId: string, exceptId?: string): Promise<{ credit: Prisma.Decimal; available: Prisma.Decimal }> {
    const credit = (await this.foliosService.totalsInTx(tx, folioId)).balanceDue.negated();
    const outstanding = await tx.refund.aggregate({
      _sum: { amount: true },
      where: { folioId, status: { in: OUTSTANDING }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    const left = credit.minus(outstanding._sum.amount ?? ZERO);
    return { credit, available: left.greaterThan(0) ? left : ZERO };
  }

  /** Refunds made, approved or asked for against one payment. */
  private async refundedAgainst(tx: TenantTx, paymentId: string): Promise<Prisma.Decimal> {
    const sum = await tx.refund.aggregate({ _sum: { amount: true }, where: { paymentId, status: { in: [...OUTSTANDING, 'processed'] } } });
    return sum._sum.amount ?? ZERO;
  }

  private async findOrThrow(tx: TenantTx, refundId: string) {
    const refund = await tx.refund.findFirst({ where: { id: refundId }, include: { folio: { select: { branchId: true } } } });
    if (!refund) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Refund not found' });
    return refund;
  }

  private async audit(tx: TenantTx, tenantId: string, branchId: string, userId: string, action: string, entityId: string, after: Prisma.InputJsonValue): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, branchId, userId, action, entityType: 'refund', entityId, after } });
  }
}
