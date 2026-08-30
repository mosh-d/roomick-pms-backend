import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateEventBookingDto, CreateEventSpaceDto } from './dto/sales-events.dto';

export interface EventSpaceSummary {
  id: string;
  name: string;
  category: string;
  capacity: number;
  createdAt: Date;
}

export interface EventBookingSummary {
  id: string;
  eventSpaceId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  contactName: string | null;
  notes: string | null;
  createdAt: Date;
}

/**
 * Sales & Events' own "Event Space Calendar" card. A booking is a time
 * range, not a night — deliberately its own model rather than reusing
 * `Room`/`Reservation`, which carry occupancy/cleanliness status and
 * night-based dates that don't apply to a ballroom.
 */
@Injectable()
export class EventSpacesService {
  constructor(private readonly prisma: PrismaService) {}

  async createSpace(tenantId: string, branchId: string, dto: CreateEventSpaceDto): Promise<EventSpaceSummary> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.eventSpace.create({ data: { tenantId, branchId, name: dto.name, category: dto.category, capacity: dto.capacity } }),
    );
  }

  async listSpaces(tenantId: string, branchId: string): Promise<EventSpaceSummary[]> {
    return this.prisma.withTenant(tenantId, (tx) => tx.eventSpace.findMany({ where: { branchId }, orderBy: { name: 'asc' } }));
  }

  /** Every booking across every space under the branch, in a date range — the calendar's own read. */
  async listBookings(tenantId: string, branchId: string, from: Date, to: Date): Promise<EventBookingSummary[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.eventBooking.findMany({
        where: { eventSpace: { branchId }, startsAt: { lt: to }, endsAt: { gt: from } },
        orderBy: { startsAt: 'asc' },
      }),
    );
  }

  /**
   * Rejects an overlapping booking on the SAME space — the one piece of
   * real business logic this card needs to be more than a bare form: two
   * groups can't be sold the same ballroom at overlapping times. Standard
   * interval-overlap test (`existing.starts < new.ends AND existing.ends >
   * new.starts`), not a naive same-day check, so two same-day bookings that
   * don't actually overlap in time both succeed.
   */
  async createBooking(tenantId: string, eventSpaceId: string, dto: CreateEventBookingDto, actorId: string): Promise<EventBookingSummary> {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'endsAt must be after startsAt' });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const space = await tx.eventSpace.findFirst({ where: { id: eventSpaceId } });
      if (!space) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Event space not found' });

      const overlapping = await tx.eventBooking.findFirst({
        where: { eventSpaceId, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
      });
      if (overlapping) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: `"${space.name}" is already booked for part of that time range` });
      }

      return tx.eventBooking.create({
        data: { tenantId, eventSpaceId, title: dto.title, startsAt, endsAt, contactName: dto.contactName, notes: dto.notes, createdBy: actorId },
      });
    });
  }

  async cancelBooking(tenantId: string, bookingId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      const booking = await tx.eventBooking.findFirst({ where: { id: bookingId } });
      if (!booking) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Event booking not found' });
      await tx.eventBooking.delete({ where: { id: bookingId } });
    });
  }
}
