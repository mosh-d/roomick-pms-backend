import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventBooking, EventSpace, Prisma } from '@prisma/client';
import { SystemRole } from '../../common/decorators/roles.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { assertRoleAtBranch } from '../../common/utils/branch-roles';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { TaxesService } from '../taxes/taxes.service';
import { renderBeoPdf } from './beo-pdf.util';
import { CreateEventBookingDto, CreateEventSpaceDto, SETUP_STYLES, SetupStyle, UpdateEventBookingDto } from './dto/sales-events.dto';

const ZERO = new Prisma.Decimal(0);
const EVENT_STAFF_ROLES = [SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk];

export const SETUP_STYLE_LABELS: Record<SetupStyle, string> = {
  theater: 'Theatre',
  classroom: 'Classroom',
  banquet: 'Banquet',
  u_shape: 'U-shape',
};

export type SetupCapacities = Partial<Record<SetupStyle, number>>;
export type CateringLine = { description: string; quantity: number; unitPrice: number };

export interface EventSpaceSummary {
  id: string;
  name: string;
  category: string;
  capacity: number;
  setupCapacities: SetupCapacities | null;
  createdAt: Date;
}

export interface EventBookingSummary {
  id: string;
  eventSpaceId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  setupStyle: string | null;
  headcount: number | null;
  catering: CateringLine[];
  avRequirements: string | null;
  notes: string | null;
  createdAt: Date;
}

/** A booking with its space and its catering priced: a line's amount, the subtotal, tax by the branch's F&B rules, and the total. */
export interface EventBookingDetail extends EventBookingSummary {
  space: EventSpaceSummary;
  currency: string;
  cateringLines: Array<CateringLine & { amount: string }>;
  totals: { subtotal: string; taxTotal: string; total: string };
}

function parseCapacities(value: Prisma.JsonValue | null | undefined): SetupCapacities | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const capacities: SetupCapacities = {};
  for (const style of SETUP_STYLES) {
    const seats = (value as Record<string, unknown>)[style];
    if (typeof seats === 'number' && seats > 0) capacities[style] = seats;
  }
  return Object.keys(capacities).length > 0 ? capacities : null;
}

function parseCatering(value: Prisma.JsonValue | null | undefined): CateringLine[] {
  return Array.isArray(value) ? (value as unknown as CateringLine[]) : [];
}

/** Seats for a layout: the space's own figure for it, else its general capacity. */
export function seatsFor(space: { capacity: number; setupCapacities: Prisma.JsonValue | null }, setupStyle: string | null | undefined): number {
  const specific = setupStyle ? parseCapacities(space.setupCapacities)?.[setupStyle as SetupStyle] : undefined;
  return specific ?? space.capacity;
}

function toSpaceSummary(space: EventSpace): EventSpaceSummary {
  return {
    id: space.id,
    name: space.name,
    category: space.category,
    capacity: space.capacity,
    setupCapacities: parseCapacities(space.setupCapacities),
    createdAt: space.createdAt,
  };
}

function toBookingSummary(booking: EventBooking): EventBookingSummary {
  return {
    id: booking.id,
    eventSpaceId: booking.eventSpaceId,
    title: booking.title,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    contactName: booking.contactName ?? null,
    contactEmail: booking.contactEmail ?? null,
    contactPhone: booking.contactPhone ?? null,
    setupStyle: booking.setupStyle ?? null,
    headcount: booking.headcount ?? null,
    catering: parseCatering(booking.catering),
    avRequirements: booking.avRequirements ?? null,
    notes: booking.notes ?? null,
    createdAt: booking.createdAt,
  };
}

/** `undefined` leaves a field as it is; a blank string clears it. */
function optionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Sales & Events' "Event Space Calendar". A booking is a time range on a
 * venue, not a night on a room — its own model rather than `Room`/
 * `Reservation`. Each booking carries what its Banquet Event Order needs:
 * layout, guaranteed headcount (checked against the space's seats for that
 * layout), contact, priced catering and AV. Catering is priced on the fly
 * and never stored as totals; its tax uses the branch's F&B rules and is an
 * estimate — an event isn't billed through a folio yet.
 */
@Injectable()
export class EventSpacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxesService: TaxesService,
  ) {}

  async createSpace(tenantId: string, branchId: string, dto: CreateEventSpaceDto): Promise<EventSpaceSummary> {
    const capacities = parseCapacities(dto.setupCapacities ? { ...dto.setupCapacities } : null);
    return this.prisma.withTenant(tenantId, async (tx) =>
      toSpaceSummary(
        await tx.eventSpace.create({
          data: { tenantId, branchId, name: dto.name, category: dto.category, capacity: dto.capacity, setupCapacities: capacities ?? undefined },
        }),
      ),
    );
  }

  async listSpaces(tenantId: string, branchId: string): Promise<EventSpaceSummary[]> {
    return this.prisma.withTenant(tenantId, async (tx) => (await tx.eventSpace.findMany({ where: { branchId }, orderBy: { name: 'asc' } })).map(toSpaceSummary));
  }

  /** Every booking across every space under the branch, in a date range — the calendar's own read. */
  async listBookings(tenantId: string, branchId: string, from: Date, to: Date): Promise<EventBookingSummary[]> {
    return this.prisma.withTenant(tenantId, async (tx) =>
      (
        await tx.eventBooking.findMany({
          where: { eventSpace: { branchId }, startsAt: { lt: to }, endsAt: { gt: from } },
          orderBy: { startsAt: 'asc' },
        })
      ).map(toBookingSummary),
    );
  }

  /**
   * Rejects an overlapping booking on the SAME space — two groups can't be
   * sold the same ballroom at overlapping times. Standard interval-overlap
   * test (`existing.starts < new.ends AND existing.ends > new.starts`), not a
   * naive same-day check, so two same-day bookings that don't actually
   * overlap in time both succeed.
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
      this.assertFits(space, dto.setupStyle, dto.headcount);
      await this.assertNoOverlap(tx, space, startsAt, endsAt);

      const booking = await tx.eventBooking.create({
        data: {
          tenantId,
          eventSpaceId,
          title: dto.title,
          startsAt,
          endsAt,
          contactName: dto.contactName,
          notes: dto.notes,
          setupStyle: dto.setupStyle,
          headcount: dto.headcount,
          contactEmail: dto.contactEmail,
          contactPhone: dto.contactPhone,
          catering: dto.catering ? this.cateringJson(dto.catering) : undefined,
          avRequirements: dto.avRequirements,
          createdBy: actorId,
        },
      });
      return toBookingSummary(booking);
    });
  }

  /** Fills in or changes the event's details as they firm up. Moving it re-checks the space is free; the headcount is re-checked against the layout. */
  async updateBooking(tenantId: string, bookingId: string, dto: UpdateEventBookingDto, actor: JwtPayload): Promise<EventBookingDetail> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const { booking, space } = await this.loadBooking(tx, bookingId);
      assertRoleAtBranch(actor, space.branchId, EVENT_STAFF_ROLES);

      const startsAt = dto.startsAt ? new Date(dto.startsAt) : booking.startsAt;
      const endsAt = dto.endsAt ? new Date(dto.endsAt) : booking.endsAt;
      if (endsAt <= startsAt) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'endsAt must be after startsAt' });
      }
      if (startsAt.getTime() !== booking.startsAt.getTime() || endsAt.getTime() !== booking.endsAt.getTime()) {
        await this.assertNoOverlap(tx, space, startsAt, endsAt, booking.id);
      }
      const setupStyle = dto.setupStyle !== undefined ? dto.setupStyle : booking.setupStyle;
      const headcount = dto.headcount !== undefined ? dto.headcount : booking.headcount;
      this.assertFits(space, setupStyle, headcount);

      const updated = await tx.eventBooking.update({
        where: { id: booking.id },
        data: {
          title: dto.title?.trim() || undefined,
          startsAt,
          endsAt,
          setupStyle: dto.setupStyle !== undefined ? (dto.setupStyle ?? null) : undefined,
          headcount: dto.headcount !== undefined ? (dto.headcount ?? null) : undefined,
          contactName: optionalText(dto.contactName),
          contactEmail: optionalText(dto.contactEmail),
          contactPhone: optionalText(dto.contactPhone),
          catering: dto.catering !== undefined ? this.cateringJson(dto.catering ?? []) : undefined,
          avRequirements: optionalText(dto.avRequirements),
          notes: optionalText(dto.notes),
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId: space.branchId,
          userId: actor.sub,
          action: 'event_booking.updated',
          entityType: 'event_booking',
          entityId: booking.id,
          after: { fields: Object.keys(dto) },
        },
      });
      return this.detail(tx, updated, space);
    });
  }

  async getBooking(tenantId: string, bookingId: string, actor: JwtPayload): Promise<EventBookingDetail> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const { booking, space } = await this.loadBooking(tx, bookingId);
      assertRoleAtBranch(actor, space.branchId, EVENT_STAFF_ROLES);
      return this.detail(tx, booking, space);
    });
  }

  /** The Banquet Event Order as a PDF, dates and times in the branch's own timezone. */
  async getBeoPdf(tenantId: string, bookingId: string, actor: JwtPayload): Promise<{ filename: string; pdf: Buffer }> {
    const { spec, title } = await this.prisma.withTenant(tenantId, async (tx) => {
      const { booking, space } = await this.loadBooking(tx, bookingId);
      assertRoleAtBranch(actor, space.branchId, EVENT_STAFF_ROLES);
      const branch = await tx.branch.findFirst({ where: { id: space.branchId }, select: { name: true, timezone: true, currency: true } });
      const timezone = branch?.timezone ?? 'UTC';
      const currency = branch?.currency ?? '';
      const lines = parseCatering(booking.catering);
      const totals = await this.cateringTotals(tx, space.branchId, lines);

      const day = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
      const money = (amount: Prisma.Decimal) =>
        `${currency} ${amount.toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
      const startDay = day.format(booking.startsAt);
      const endDay = day.format(booking.endsAt);
      const style = booking.setupStyle as SetupStyle | null;
      const contact = [booking.contactName, booking.contactPhone, booking.contactEmail].filter((part): part is string => !!part).join('  ·  ');

      return {
        title: booking.title,
        spec: {
          propertyName: branch?.name ?? '',
          beoNumber: `BEO-${booking.id.slice(0, 8).toUpperCase()}`,
          printedOn: day.format(new Date()),
          title: booking.title,
          date: startDay === endDay ? startDay : `${startDay} – ${endDay}`,
          time: `${clock.format(booking.startsAt)} – ${clock.format(booking.endsAt)}`,
          venue: space.name,
          setup: style && SETUP_STYLE_LABELS[style] ? `${SETUP_STYLE_LABELS[style]} (seats ${seatsFor(space, style)})` : 'Not set',
          headcount: booking.headcount ? String(booking.headcount) : 'Not set',
          contact: contact || 'Not set',
          catering: lines.map((line) => ({
            description: line.description,
            quantity: String(line.quantity),
            unitPrice: money(new Prisma.Decimal(line.unitPrice)),
            amount: money(new Prisma.Decimal(line.unitPrice).mul(line.quantity)),
          })),
          subtotal: money(totals.subtotal),
          tax: money(totals.taxTotal),
          total: money(totals.total),
          avRequirements: booking.avRequirements,
          notes: booking.notes,
        },
      };
    });
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    return { filename: `beo-${slug || 'event'}.pdf`, pdf: await renderBeoPdf(spec) };
  }

  async cancelBooking(tenantId: string, bookingId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      const booking = await tx.eventBooking.findFirst({ where: { id: bookingId } });
      if (!booking) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Event booking not found' });
      await tx.eventBooking.delete({ where: { id: bookingId } });
    });
  }

  // -------------------------------------------------------------------------

  private async loadBooking(tx: TenantTx, bookingId: string): Promise<{ booking: EventBooking; space: EventSpace }> {
    const booking = await tx.eventBooking.findFirst({ where: { id: bookingId }, include: { eventSpace: true } });
    if (!booking) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Event booking not found' });
    const { eventSpace, ...rest } = booking;
    return { booking: rest, space: eventSpace };
  }

  private async assertNoOverlap(tx: TenantTx, space: EventSpace, startsAt: Date, endsAt: Date, exceptBookingId?: string): Promise<void> {
    const overlapping = await tx.eventBooking.findFirst({
      where: {
        eventSpaceId: space.id,
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        ...(exceptBookingId ? { id: { not: exceptBookingId } } : {}),
      },
    });
    if (overlapping) {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: `"${space.name}" is already booked for part of that time range` });
    }
  }

  private assertFits(space: EventSpace, setupStyle: string | null | undefined, headcount: number | null | undefined): void {
    if (!headcount) return;
    const seats = seatsFor(space, setupStyle);
    if (headcount > seats) {
      const layout = setupStyle && SETUP_STYLE_LABELS[setupStyle as SetupStyle] ? ` ${SETUP_STYLE_LABELS[setupStyle as SetupStyle].toLowerCase()}-style` : '';
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: `${space.name} seats ${seats}${layout} — ${headcount} is more than it holds` });
    }
  }

  private cateringJson(lines: CateringLine[]): CateringLine[] {
    return lines.map((line) => ({ description: line.description.trim(), quantity: line.quantity, unitPrice: line.unitPrice }));
  }

  private async cateringTotals(tx: TenantTx, branchId: string, lines: CateringLine[]) {
    const subtotal = lines.reduce((sum, line) => sum.plus(new Prisma.Decimal(line.unitPrice).mul(line.quantity)), ZERO);
    const taxes = subtotal.greaterThan(0) ? await this.taxesService.computeTaxesForCharge(tx, branchId, 'fnb', subtotal) : [];
    const taxTotal = taxes.reduce((sum, tax) => sum.plus(tax.taxAmount), ZERO);
    return { subtotal, taxTotal, total: subtotal.plus(taxTotal) };
  }

  private async detail(tx: TenantTx, booking: EventBooking, space: EventSpace): Promise<EventBookingDetail> {
    const branch = await tx.branch.findFirst({ where: { id: space.branchId }, select: { currency: true } });
    const lines = parseCatering(booking.catering);
    const totals = await this.cateringTotals(tx, space.branchId, lines);
    return {
      ...toBookingSummary(booking),
      space: toSpaceSummary(space),
      currency: branch?.currency ?? '',
      cateringLines: lines.map((line) => ({ ...line, amount: new Prisma.Decimal(line.unitPrice).mul(line.quantity).toFixed(2) })),
      totals: { subtotal: totals.subtotal.toFixed(2), taxTotal: totals.taxTotal.toFixed(2), total: totals.total.toFixed(2) },
    };
  }
}
