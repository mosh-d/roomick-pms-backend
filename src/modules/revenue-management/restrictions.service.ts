import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
    const created = await this.prisma.withTenant(tenantId, (tx) =>
      tx.availabilityRestriction.create({
        data: {
          tenantId,
          branchId,
          roomTypeId: dto.roomTypeId,
          startDate: toBranchDate(dto.startDate),
          endDate: toBranchDate(dto.endDate),
          minLOS: dto.minLOS,
          maxLOS: dto.maxLOS,
          closedToArrival: dto.closedToArrival ?? false,
          stopSell: dto.stopSell ?? false,
          createdBy: actorId,
        },
        include: { roomType: { select: { name: true } } },
      }),
    );
    return this.toSummary(created);
  }

  async listRestrictions(tenantId: string, branchId: string): Promise<AvailabilityRestrictionSummary[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.availabilityRestriction.findMany({ where: { branchId }, orderBy: { startDate: 'asc' }, include: { roomType: { select: { name: true } } } }),
    );
    return rows.map((r) => this.toSummary(r));
  }

  async deleteRestriction(tenantId: string, restrictionId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      const restriction = await tx.availabilityRestriction.findFirst({ where: { id: restrictionId } });
      if (!restriction) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Restriction not found' });
      await tx.availabilityRestriction.delete({ where: { id: restrictionId } });
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
