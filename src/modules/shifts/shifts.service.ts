import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Shift, ShiftIssue } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { AddShiftIssueDto, CloseShiftDto, OpenShiftDto, UpdateShiftIssueDto } from './dto/shift.dto';

/** No dedicated branch column for this — reuses `Branch.policies` (already the catch-all for loose per-branch config like AR flag rules). Unset = 5.00 in the branch currency, a sane default rather than forcing every branch to configure it before shifts work at all. */
const DEFAULT_VARIANCE_THRESHOLD = 5;

@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
  ) {}

  async openShift(tenantId: string, branchId: string, dto: OpenShiftDto, actorId: string): Promise<Shift> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);

      const existing = await tx.shift.findFirst({ where: { branchId, agentId: actorId, closedAt: null } });
      if (existing) {
        throw new ConflictException({
          code: ErrorCode.SHIFT_ALREADY_OPEN,
          message: 'You already have an open shift on this branch — close it before opening another.',
        });
      }

      const shift = await tx.shift.create({
        data: {
          tenantId,
          branchId,
          agentId: actorId,
          shiftType: dto.shiftType,
          openingFloat: new Prisma.Decimal(dto.openingFloat),
          openingBreakdown: dto.openingBreakdown as unknown as Prisma.InputJsonValue | undefined,
        },
      });
      await this.audit(tx, tenantId, branchId, actorId, 'shift.opened', shift.id, {
        shiftType: dto.shiftType,
        openingFloat: dto.openingFloat,
      });
      return shift;
    });
  }

  /**
   * `systemCashTotal` = opening float + every non-void CASH payment this
   * session recorded (`FoliosService.recordPayment` stamps `shiftId` on cash
   * payments as they're taken — see the comment there). Refunds already net
   * out: `Payment.amount` is negative for a refund, so the sum is the actual
   * expected drawer balance, not just gross intake.
   */
  async closeShift(tenantId: string, shiftId: string, dto: CloseShiftDto, actorId: string): Promise<Shift> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const shift = await tx.shift.findFirst({ where: { id: shiftId } });
      if (!shift) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Shift not found' });
      }
      if (shift.closedAt) {
        throw new ConflictException({ code: ErrorCode.SHIFT_ALREADY_CLOSED, message: 'This shift is already closed.' });
      }
      const branch = await this.propertyService.assertBranch(tx, shift.branchId);

      const cashAgg = await tx.payment.aggregate({
        _sum: { amount: true },
        where: { shiftId, method: 'cash', isVoid: false },
      });
      const cashMovement = cashAgg._sum.amount ?? new Prisma.Decimal(0);
      const openingFloat = shift.openingFloat ?? new Prisma.Decimal(0);
      const systemCashTotal = openingFloat.add(cashMovement);
      const closingCashCounted = new Prisma.Decimal(dto.closingCashCounted);
      const variance = closingCashCounted.sub(systemCashTotal);

      const policies = branch.policies as Record<string, unknown> | null;
      const configuredThreshold = policies?.cashVarianceThreshold;
      const threshold = new Prisma.Decimal(typeof configuredThreshold === 'number' ? configuredThreshold : DEFAULT_VARIANCE_THRESHOLD);

      if (variance.abs().greaterThan(threshold) && !dto.varianceExplanation) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: `Variance of ${variance.toFixed(2)} exceeds the ${threshold.toFixed(2)} threshold for this branch — a variance explanation is required to close this shift.`,
        });
      }

      const updated = await tx.shift.update({
        where: { id: shiftId },
        data: {
          closedAt: new Date(),
          systemCashTotal,
          closingCashCounted,
          closingBreakdown: dto.closingBreakdown as unknown as Prisma.InputJsonValue | undefined,
          variance,
          varianceExplanation: dto.varianceExplanation,
          handoverNotes: dto.handoverNotes,
        },
      });

      // Reference UI (pms-frontend-structure) bundles new "hand to the next
      // shift" issues into the close action itself rather than a separate
      // round trip — logged against THIS (now-closing) shift so they surface
      // in `getHandoverContext`'s branch-wide unresolved query for whoever
      // opens next.
      for (const issueDto of dto.unresolvedIssues ?? []) {
        await tx.shiftIssue.create({
          data: { tenantId, shiftId, description: issueDto.description, priority: issueDto.priority ?? 'medium' },
        });
      }

      await this.audit(tx, tenantId, shift.branchId, actorId, 'shift.closed', shift.id, {
        systemCashTotal: systemCashTotal.toFixed(2),
        closingCashCounted: dto.closingCashCounted,
        variance: variance.toFixed(2),
      });
      return updated;
    });
  }

  async getShift(tenantId: string, shiftId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const shift = await tx.shift.findFirst({
        where: { id: shiftId },
        include: {
          agent: { select: { id: true, name: true } },
          issues: { orderBy: { createdAt: 'asc' } },
          payments: { where: { isVoid: false }, orderBy: { recordedAt: 'asc' } },
        },
      });
      if (!shift) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Shift not found' });
      }
      return shift;
    });
  }

  async listShifts(tenantId: string, branchId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.shift.findMany({
        where: { branchId },
        orderBy: { openedAt: 'desc' },
        include: { agent: { select: { id: true, name: true } }, issues: true },
      }),
    );
  }

  /** The calling agent's own open shift on this branch, or null — lets the front end show "Open Shift" vs "Close Shift" without the caller guessing. */
  async getCurrentShift(tenantId: string, branchId: string, actorId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.shift.findFirst({
        where: { branchId, agentId: actorId, closedAt: null },
        include: { issues: { where: { status: { not: 'resolved' } }, orderBy: { createdAt: 'asc' } } },
      }),
    );
  }

  /**
   * "Handover notes and unresolved issues carry to next shift" (spec M5) —
   * the most recently closed shift's own notes, plus every unresolved issue
   * branch-wide (not just that one shift's), since an issue can outlive
   * more than one shift boundary before anyone gets to it.
   */
  async getHandoverContext(tenantId: string, branchId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const lastClosedShift = await tx.shift.findFirst({
        where: { branchId, closedAt: { not: null } },
        orderBy: { closedAt: 'desc' },
        include: { agent: { select: { id: true, name: true } } },
      });
      const unresolvedIssues = await tx.shiftIssue.findMany({
        where: { shift: { branchId }, status: { not: 'resolved' } },
        orderBy: { createdAt: 'asc' },
        include: { shift: { select: { id: true, shiftType: true, openedAt: true, agent: { select: { name: true } } } } },
      });
      return { lastClosedShift, unresolvedIssues };
    });
  }

  async addShiftIssue(tenantId: string, shiftId: string, dto: AddShiftIssueDto, actorId: string): Promise<ShiftIssue> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const shift = await tx.shift.findFirst({ where: { id: shiftId } });
      if (!shift) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Shift not found' });
      }
      const issue = await tx.shiftIssue.create({
        data: { tenantId, shiftId, description: dto.description, priority: dto.priority ?? 'medium' },
      });
      await this.audit(tx, tenantId, shift.branchId, actorId, 'shift_issue.created', issue.id, { shiftId, description: dto.description });
      return issue;
    });
  }

  /**
   * "Resolve / Carry Over buttons... Issues are never silently deleted."
   * (pms-frontend-structure) — the incoming agent picks one of two real
   * outcomes for each open issue: `resolved` (stamped with who/when, an
   * optional note) or `carried_over` (still unresolved, explicitly passed
   * forward again — distinct from just leaving it `open`, so a manager
   * scanning history can tell "never looked at" from "looked at, still
   * unresolved"). Both are terminal for THIS transition; `carried_over` can
   * itself be carried over or resolved again later.
   */
  async updateShiftIssue(tenantId: string, issueId: string, dto: UpdateShiftIssueDto, actorId: string): Promise<ShiftIssue> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const issue = await tx.shiftIssue.findFirst({ where: { id: issueId }, include: { shift: true } });
      if (!issue) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Shift issue not found' });
      }
      if (issue.status === 'resolved') {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This issue is already resolved.' });
      }
      const updated = await tx.shiftIssue.update({
        where: { id: issueId },
        data:
          dto.status === 'resolved'
            ? { status: 'resolved', resolution: dto.resolution, resolvedBy: actorId, resolvedAt: new Date() }
            : { status: 'carried_over', resolution: dto.resolution },
      });
      await this.audit(tx, tenantId, issue.shift.branchId, actorId, `shift_issue.${dto.status}`, issue.id, { resolution: dto.resolution });
      return updated;
    });
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
      data: { tenantId, branchId, userId, action, entityType: 'shift', entityId, after },
    });
  }
}
