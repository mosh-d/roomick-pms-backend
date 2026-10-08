import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { toBranchDate } from '../../common/utils/branch-date';
import { CreateAvailabilityRestrictionDto } from './dto/revenue-management.dto';

export interface AvailabilityRestrictionSummary {
  id: string;
  roomTypeId: string | null;
  roomTypeName: string | null;
  startDate: Date;
  endDate: Date;
  minLOS: number | null;
  maxLOS: number | null;
  closedToArrival: boolean;
  stopSell: boolean;
  createdAt: Date;
}

/**
 * Revenue Management's own "Restrictions Management" card (ref: "MinLOS,
 * CTA, MaxLOS, stop-sell"). A genuinely different concept from `RatePlan
 * .minLOS` (which only decides which rate-cascade tier applies, never
 * blocks a booking) — see this model's own schema comment.
 *
 * `assertNoViolation` is called from `ReservationsService.createReservation`
 * only (not `walkIn`) — a same-day walk-in stay is exempt from length-of-
 * stay restrictions in practice, and adding a second integration point to
 * an already-tested method was judged a real, separate piece of scope, not
 * folded into this pass. A tenant that never configures a restriction sees
 * zero behavior change either way — the query returns nothing to violate.
 */
@Injectable()
export class RestrictionsService {
  constructor(private readonly prisma: PrismaService) {}

  async createRestriction(tenantId: string, branchId: string, dto: CreateAvailabilityRestrictionDto, actorId: string): Promise<AvailabilityRestrictionSummary> {
    const startDate = toBranchDate(dto.startDate);
    const endDate = toBranchDate(dto.endDate);
    if (!(endDate > startDate)) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'The end date must be after the start date' });
    }
    if (dto.minLOS && dto.maxLOS && dto.minLOS > dto.maxLOS) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'The minimum stay can’t be longer than the maximum stay' });
    }
    if (!dto.minLOS && !dto.maxLOS && !dto.closedToArrival && !dto.stopSell) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'A restriction needs at least one rule — a minimum or maximum stay, closed to arrival, or stop-sell' });
    }
    const created = await this.prisma.withTenant(tenantId, async (tx) => {
      if (dto.roomTypeId) {
        const roomType = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, branchId, deletedAt: null }, select: { id: true } });
        if (!roomType) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found at this branch' });
      }
      // One rule set per room type per night — two overlapping ones would contradict each other.
      const overlapping = await tx.availabilityRestriction.findFirst({
        where: { branchId, roomTypeId: dto.roomTypeId ?? null, startDate: { lt: endDate }, endDate: { gt: startDate } },
        select: { startDate: true, endDate: true },
      });
      if (overlapping) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: `A restriction already covers ${overlapping.startDate.toISOString().slice(0, 10)} to ${overlapping.endDate.toISOString().slice(0, 10)} for ${dto.roomTypeId ? 'this room type' : 'all room types'} — remove it first`,
        });
      }
      const row = await tx.availabilityRestriction.create({
        data: {
          tenantId,
          branchId,
          roomTypeId: dto.roomTypeId,
          startDate,
          endDate,
          minLOS: dto.minLOS,
          maxLOS: dto.maxLOS,
          closedToArrival: dto.closedToArrival ?? false,
          stopSell: dto.stopSell ?? false,
          createdBy: actorId,
        },
        include: { roomType: { select: { name: true } } },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId,
          userId: actorId,
          action: 'availability_restriction.created',
          entityType: 'availability_restriction',
          entityId: row.id,
          after: { roomTypeId: dto.roomTypeId ?? null, startDate: dto.startDate, endDate: dto.endDate, minLOS: dto.minLOS ?? null, maxLOS: dto.maxLOS ?? null, closedToArrival: row.closedToArrival, stopSell: row.stopSell },
        },
      });
      return row;
    });
    return this.toSummary(created);
  }

  async listRestrictions(tenantId: string, branchId: string): Promise<AvailabilityRestrictionSummary[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.availabilityRestriction.findMany({ where: { branchId }, orderBy: { startDate: 'asc' }, include: { roomType: { select: { name: true } } } }),
    );
    return rows.map((r) => this.toSummary(r));
  }

  async deleteRestriction(tenantId: string, restrictionId: string, actorId?: string): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      const restriction = await tx.availabilityRestriction.findFirst({ where: { id: restrictionId } });
      if (!restriction) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Restriction not found' });
      await tx.availabilityRestriction.delete({ where: { id: restrictionId } });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId: restriction.branchId,
          userId: actorId ?? null,
          action: 'availability_restriction.removed',
          entityType: 'availability_restriction',
          entityId: restrictionId,
          before: { roomTypeId: restriction.roomTypeId, startDate: restriction.startDate.toISOString().slice(0, 10), endDate: restriction.endDate.toISOString().slice(0, 10), stopSell: restriction.stopSell },
        },
      });
    });
  }

  /**
   * Called INSIDE an already-open reservation-creation transaction (not a
   * new `withTenant` of its own) — `tx` is passed straight through from
   * `ReservationsService`, matching how `assertWithinCapacity`/
   * `assertAvailableForStay` already receive it.
   */
  async assertNoViolation(tx: TenantTx, branchId: string, roomTypeId: string, checkInDate: Date, checkOutDate: Date): Promise<void> {
    const restrictions = await tx.availabilityRestriction.findMany({
      where: {
        branchId,
        OR: [{ roomTypeId: null }, { roomTypeId }],
        startDate: { lt: checkOutDate },
        endDate: { gt: checkInDate },
      },
    });
    if (restrictions.length === 0) return;

    const stayLength = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / 86_400_000);

    for (const r of restrictions) {
      if (r.stopSell) {
        throw new ConflictException({ code: ErrorCode.RESERVATION_NOT_AVAILABLE, message: 'Bookings are not available for these dates (stop-sell in effect)' });
      }
      if (r.closedToArrival && checkInDate >= r.startDate && checkInDate < r.endDate) {
        throw new ConflictException({ code: ErrorCode.RESERVATION_NOT_AVAILABLE, message: 'Arrivals are not permitted on this check-in date' });
      }
      if (r.minLOS && stayLength < r.minLOS) {
        throw new ConflictException({ code: ErrorCode.RESERVATION_NOT_AVAILABLE, message: `A minimum stay of ${r.minLOS} nights is required for these dates` });
      }
      if (r.maxLOS && stayLength > r.maxLOS) {
        throw new ConflictException({ code: ErrorCode.RESERVATION_NOT_AVAILABLE, message: `Stays longer than ${r.maxLOS} nights are not permitted for these dates` });
      }
    }
  }

  /**
   * For a stay that already exists and grows: stop-sell on the nights being
   * added, and the maximum stay over the whole of it. Never the arrival
   * rules — the guest has arrived — and never a minimum stay against the
   * extension alone, which would refuse one more night under a two-night rule.
   */
  async assertExtensionAllowed(tx: TenantTx, branchId: string, roomTypeId: string, checkInDate: Date, oldCheckOutDate: Date, newCheckOutDate: Date): Promise<void> {
    const restrictions = await tx.availabilityRestriction.findMany({
      where: { branchId, OR: [{ roomTypeId: null }, { roomTypeId }], startDate: { lt: newCheckOutDate }, endDate: { gt: checkInDate } },
    });
    if (restrictions.length === 0) return;
    const stayLength = Math.round((newCheckOutDate.getTime() - checkInDate.getTime()) / 86_400_000);
    for (const r of restrictions) {
      const touchesAddedNights = r.startDate < newCheckOutDate && r.endDate > oldCheckOutDate;
      if (r.stopSell && touchesAddedNights) {
        throw new ConflictException({ code: ErrorCode.RESERVATION_NOT_AVAILABLE, message: 'The added nights are not available (stop-sell in effect)' });
      }
      if (r.maxLOS && stayLength > r.maxLOS) {
        throw new ConflictException({ code: ErrorCode.RESERVATION_NOT_AVAILABLE, message: `Stays longer than ${r.maxLOS} nights are not permitted for these dates` });
      }
    }
  }

  private toSummary(row: { id: string; roomTypeId: string | null; roomType: { name: string } | null; startDate: Date; endDate: Date; minLOS: number | null; maxLOS: number | null; closedToArrival: boolean; stopSell: boolean; createdAt: Date }): AvailabilityRestrictionSummary {
    return {
      id: row.id,
      roomTypeId: row.roomTypeId,
      roomTypeName: row.roomType?.name ?? null,
      startDate: row.startDate,
      endDate: row.endDate,
      minLOS: row.minLOS,
      maxLOS: row.maxLOS,
      closedToArrival: row.closedToArrival,
      stopSell: row.stopSell,
      createdAt: row.createdAt,
    };
  }
}
