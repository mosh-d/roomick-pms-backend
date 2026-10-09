import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ChannelAllotment, Prisma, ReservationChannel } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { CreateChannelAllotmentDto, UpdateChannelAllotmentDto } from './dto/channel-allotment.dto';

export const CHANNEL_LABELS: Record<ReservationChannel, string> = {
  direct: 'Direct',
  website: 'Website',
  walk_in: 'Walk-in',
  booking_com: 'Booking.com',
  expedia: 'Expedia',
  agoda: 'Agoda',
  airbnb: 'Airbnb',
};

export interface ChannelAllotmentView {
  id: string;
  roomTypeId: string;
  roomTypeName: string;
  channel: ReservationChannel;
  fromDate: string;
  toDate: string;
  rooms: number;
}

const day = (value: Date) => value.toISOString().slice(0, 10);

/**
 * Channel allotments: how many of a room type one channel may sell a night,
 * over a date range — "the website sells at most 3 Deluxe a night in
 * December", or an OTA's share once a channel manager is connected. A
 * ceiling, not a set-aside: the other channels still sell what's left, and
 * a channel with no allotment sells from the whole house as before. Where
 * two allotments for the same channel overlap, the smaller one governs.
 */
@Injectable()
export class ChannelAllotmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
  ) {}

  async list(tenantId: string, branchId: string): Promise<ChannelAllotmentView[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const rows = await tx.channelAllotment.findMany({
        where: { branchId },
        include: { roomType: { select: { name: true } } },
        orderBy: [{ fromDate: 'asc' }, { channel: 'asc' }],
      });
      return rows.map((r) => this.view(r, r.roomType.name));
    });
  }

  async create(tenantId: string, branchId: string, dto: CreateChannelAllotmentDto, actorId: string): Promise<ChannelAllotmentView> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const roomType = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, branchId, deletedAt: null }, select: { name: true } });
      if (!roomType) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found at this property' });
      this.assertDates(dto.fromDate, dto.toDate);
      const row = await tx.channelAllotment.create({
        data: { tenantId, branchId, roomTypeId: dto.roomTypeId, channel: dto.channel, fromDate: toBranchDate(dto.fromDate), toDate: toBranchDate(dto.toDate), rooms: dto.rooms, createdBy: actorId },
      });
      await this.audit(tx, tenantId, branchId, actorId, 'channel_allotment.created', row.id, { channel: dto.channel, roomType: roomType.name, fromDate: dto.fromDate, toDate: dto.toDate, rooms: dto.rooms });
      return this.view(row, roomType.name);
    });
  }

  async update(tenantId: string, allotmentId: string, dto: UpdateChannelAllotmentDto, actorId: string): Promise<ChannelAllotmentView> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.channelAllotment.findFirst({ where: { id: allotmentId }, include: { roomType: { select: { name: true } } } });
      if (!existing) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Allotment not found' });
      const fromDate = dto.fromDate ?? day(existing.fromDate);
      const toDate = dto.toDate ?? day(existing.toDate);
      this.assertDates(fromDate, toDate);
      const row = await tx.channelAllotment.update({
        where: { id: allotmentId },
        data: { fromDate: toBranchDate(fromDate), toDate: toBranchDate(toDate), rooms: dto.rooms },
      });
      await this.audit(tx, tenantId, existing.branchId, actorId, 'channel_allotment.updated', row.id, {
        before: { fromDate: day(existing.fromDate), toDate: day(existing.toDate), rooms: existing.rooms },
        after: { fromDate, toDate, rooms: row.rooms },
      });
      return this.view(row, existing.roomType.name);
    });
  }

  async remove(tenantId: string, allotmentId: string, actorId: string): Promise<{ removed: true }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.channelAllotment.findFirst({ where: { id: allotmentId } });
      if (!existing) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Allotment not found' });
      await tx.channelAllotment.delete({ where: { id: allotmentId } });
      await this.audit(tx, tenantId, existing.branchId, actorId, 'channel_allotment.removed', allotmentId, { channel: existing.channel, rooms: existing.rooms });
      return { removed: true };
    });
  }

  /**
   * Refuses a stay its channel has no room left for on any of its nights:
   * the stays already booked through the channel, plus this one, can't
   * exceed the allotment covering the night. `exceptReservationId` is a stay
   * being changed, so it isn't counted against itself.
   */
  async assertWithinAllotment(
    tx: TenantTx,
    branchId: string,
    roomTypeId: string,
    channel: ReservationChannel,
    from: Date,
    to: Date,
    exceptReservationId?: string,
  ): Promise<void> {
    const allotments = await tx.channelAllotment.findMany({ where: { branchId, roomTypeId, channel, fromDate: { lt: to }, toDate: { gte: from } } });
    if (allotments.length === 0) return;
    const stays = await tx.reservation.findMany({
      where: {
        branchId,
        roomTypeId,
        channel,
        deletedAt: null,
        isDayUse: false,
        status: { in: ['confirmed', 'checked_in'] },
        checkInDate: { lt: to },
        checkOutDate: { gt: from },
        ...(exceptReservationId ? { id: { not: exceptReservationId } } : {}),
      },
      select: { checkInDate: true, checkOutDate: true },
    });
    for (let night = new Date(from); night < to; night = new Date(night.getTime() + 86_400_000)) {
      const covering = allotments.filter((a) => a.fromDate <= night && a.toDate >= night);
      if (covering.length === 0) continue;
      const limit = Math.min(...covering.map((a) => a.rooms));
      const sold = stays.filter((s) => s.checkInDate <= night && s.checkOutDate > night).length;
      if (sold + 1 > limit) {
        throw new ConflictException({
          code: ErrorCode.RESERVATION_NOT_AVAILABLE,
          message: `The ${CHANNEL_LABELS[channel]} allotment for this room type is full on ${day(night)} (${limit} a night)`,
        });
      }
    }
  }

  private assertDates(fromDate: string, toDate: string): void {
    if (toDate < fromDate) throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'The last night is before the first' });
  }

  private view(row: ChannelAllotment, roomTypeName: string): ChannelAllotmentView {
    return { id: row.id, roomTypeId: row.roomTypeId, roomTypeName, channel: row.channel, fromDate: day(row.fromDate), toDate: day(row.toDate), rooms: row.rooms };
  }

  private async audit(tx: TenantTx, tenantId: string, branchId: string, userId: string, action: string, entityId: string, after: Prisma.InputJsonValue): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, branchId, userId, action, entityType: 'channel_allotment', entityId, after } });
  }
}
