import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { GroupBlock } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { toBranchDate } from '../../common/utils/branch-date';
import { PrismaService } from '../../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';
import { BookIntoGroupBlockDto, CreateGroupBlockDto } from './dto/sales-events.dto';

const OPEN_RESERVATION_STATUSES = ['confirmed', 'checked_in', 'checked_out'] as const;

export interface GroupBlockSummary {
  id: string;
  name: string;
  roomTypeId: string;
  roomTypeName: string;
  blockSize: number;
  blockRate: string;
  cutoffDate: Date;
  status: string;
  pickup: number;
  createdAt: Date;
}

/**
 * Sales & Events' own "Group Block Creation" card (ref: "allot rooms, set
 * cut-off, track pickup"). Deliberately reuses `Reservation.overrideRate`/
 * `overrideReason` — the exact mechanism Manager Dashboard's own Rate
 * Override already established — rather than inventing a parallel rate
 * path for a block-booked stay. `pickup` is always computed live from real
 * `Reservation` rows (never a stored counter that could drift from what
 * actually got booked/cancelled).
 */
@Injectable()
export class GroupBlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationsService: ReservationsService,
  ) {}

  async createBlock(tenantId: string, branchId: string, dto: CreateGroupBlockDto, actorId: string): Promise<GroupBlockSummary> {
    const created = await this.prisma.withTenant(tenantId, (tx) =>
      tx.groupBlock.create({
        data: {
          tenantId,
          branchId,
          roomTypeId: dto.roomTypeId,
          name: dto.name,
          blockSize: dto.blockSize,
          blockRate: dto.blockRate,
          cutoffDate: toBranchDate(dto.cutoffDate),
          createdBy: actorId,
        },
        include: { roomType: { select: { name: true } } },
      }),
    );
    return this.toSummary(created, 0);
  }

  async listBlocks(tenantId: string, branchId: string): Promise<GroupBlockSummary[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const blocks = await tx.groupBlock.findMany({
        where: { branchId },
        orderBy: { createdAt: 'desc' },
        include: { roomType: { select: { name: true } } },
      });
      if (blocks.length === 0) return [];

      const pickups = await tx.reservation.groupBy({
        by: ['groupBlockId'],
        where: { groupBlockId: { in: blocks.map((b) => b.id) }, status: { in: [...OPEN_RESERVATION_STATUSES] } },
        _count: { _all: true },
      });
      const pickupByBlock = new Map(pickups.map((p) => [p.groupBlockId, p._count._all]));
      return blocks.map((b) => this.toSummary(b, pickupByBlock.get(b.id) ?? 0));
    });
  }

  async releaseBlock(tenantId: string, blockId: string): Promise<GroupBlockSummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const block = await tx.groupBlock.findFirst({ where: { id: blockId }, include: { roomType: { select: { name: true } } } });
      if (!block) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Group block not found' });
      const updated = await tx.groupBlock.update({ where: { id: blockId }, data: { status: 'released' }, include: { roomType: { select: { name: true } } } });
      const pickup = await tx.reservation.count({ where: { groupBlockId: blockId, status: { in: [...OPEN_RESERVATION_STATUSES] } } });
      return this.toSummary(updated, pickup);
    });
  }

  /**
   * Creates the reservation through the SAME `ReservationsService.createReservation`
   * every other booking path uses (availability check, capacity check, guest
   * find-or-create all included for free), then applies the block's own
   * rate through `setRateOverride` — the identical method + fields Manager
   * Dashboard's own Rate Override already writes. Each step is its own
   * transaction (matching how `createReservation`/`setRateOverride` already
   * work independently elsewhere) — a failure between them would leave a
   * real reservation without its block link, a rare and easily
   * manually-correctable edge case, not silent data corruption.
   */
  async bookIntoBlock(tenantId: string, blockId: string, dto: BookIntoGroupBlockDto, actorId: string): Promise<{ reservationId: string; confirmationNumber: string }> {
    const block = await this.prisma.withTenant(tenantId, (tx) => tx.groupBlock.findFirst({ where: { id: blockId } }));
    if (!block) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Group block not found' });
    if (block.status !== 'active') {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: `This block is ${block.status}, not accepting reservations` });
    }

    const pickup = await this.prisma.withTenant(tenantId, (tx) =>
      tx.reservation.count({ where: { groupBlockId: blockId, status: { in: [...OPEN_RESERVATION_STATUSES] } } }),
    );
    if (pickup >= block.blockSize) {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: `This block's full allotment of ${block.blockSize} rooms is already booked` });
    }

    const reservation = await this.reservationsService.createReservation(
      tenantId,
      block.branchId,
      { guestId: dto.guestId, guest: dto.guest, roomTypeId: block.roomTypeId, checkInDate: dto.checkInDate, checkOutDate: dto.checkOutDate, adults: dto.adults, children: dto.children },
      actorId,
    );

    await this.reservationsService.setRateOverride(tenantId, reservation.id, { overrideRate: Number(block.blockRate), reason: `Group block: ${block.name}` }, actorId);
    await this.prisma.withTenant(tenantId, (tx) => tx.reservation.update({ where: { id: reservation.id }, data: { groupBlockId: blockId } }));

    return { reservationId: reservation.id, confirmationNumber: reservation.confirmationNumber };
  }

  private toSummary(block: GroupBlock & { roomType: { name: string } }, pickup: number): GroupBlockSummary {
    return {
      id: block.id,
      name: block.name,
      roomTypeId: block.roomTypeId,
      roomTypeName: block.roomType.name,
      blockSize: block.blockSize,
      blockRate: block.blockRate.toFixed(2),
      cutoffDate: block.cutoffDate,
      status: block.status,
      pickup,
      createdAt: block.createdAt,
    };
  }
}
