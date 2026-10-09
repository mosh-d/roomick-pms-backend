import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventBooking, EventSpace, Prisma } from '@prisma/client';
import { SystemRole } from '../../common/decorators/roles.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { assertRoleAtBranch } from '../../common/utils/branch-roles';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { TaxesService } from '../taxes/taxes.service';
import { FoliosService } from '../folios/folios.service';
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
  /** `confirmed`, or `cancelled` — kept on record rather than deleted. */
  status: string;
  cancelledAt: Date | null;
  createdAt: Date;
  /** What the space costs for the event, before tax; null = no hire charge. */
  spaceHireFee: string | null;
  /** Billed: the bill its hire and catering went on, and when. */
  folioId: string | null;
  billedAt: Date | null;
}

/** A booking with its space and its catering priced: a line's amount, the subtotal, tax by the branch's F&B rules, and the total. */
export interface EventBookingDetail extends EventBookingSummary {
  space: EventSpaceSummary;
  currency: string;
  cateringLines: Array<CateringLine & { amount: string }>;
  /** Hire and catering together. `taxTotal` is added on top of `subtotal`; `taxIncluded` is already inside it. */
  totals: { hire: string; catering: string; subtotal: string; taxTotal: string; taxIncluded: string; total: string };
  /** The bill it went on, the way the desk knows it. */
  billedTo: { folioId: string; guestName: string; roomNumber: string | null; confirmationNumber: string | null } | null;
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
    status: booking.status,
    cancelledAt: booking.cancelledAt ?? null,
    createdAt: booking.createdAt,
    spaceHireFee: booking.spaceHireFee ? booking.spaceHireFee.toFixed(2) : null,
    folioId: booking.folioId ?? null,
    billedAt: booking.billedAt ?? null,
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
 * and never stored as totals; its tax uses the branch's F&B rules (the space
 * hire, the branch's rules for other charges). Billing an event puts its
 * hire and catering on a bill — a guest's, or a group's master bill — once.
 */
@Injectable()
export class EventSpacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxesService: TaxesService,
    private readonly foliosService: FoliosService,
  ) {}

  async createSpace(tenantId: string, branchId: string, dto: CreateEventSpaceDto, actorId?: string): Promise<EventSpaceSummary> {
    const capacities = parseCapacities(dto.setupCapacities ? { ...dto.setupCapacities } : null);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const space = await tx.eventSpace.create({
        data: { tenantId, branchId, name: dto.name, category: dto.category, capacity: dto.capacity, setupCapacities: capacities ?? undefined },
      });
      await tx.auditLog.create({
        data: { tenantId, branchId, userId: actorId ?? null, action: 'event_space.created', entityType: 'event_space', entityId: space.id, after: { name: dto.name, category: dto.category, capacity: dto.capacity } },
      });
      return toSpaceSummary(space);
    });
  }

  async listSpaces(tenantId: string, branchId: string): Promise<EventSpaceSummary[]> {
    return this.prisma.withTenant(tenantId, async (tx) => (await tx.eventSpace.findMany({ where: { branchId }, orderBy: { name: 'asc' } })).map(toSpaceSummary));
  }

  /** Every booking across every space under the branch, in a date range — the calendar's own read. */
  async listBookings(tenantId: string, branchId: string, from: Date, to: Date): Promise<EventBookingSummary[]> {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || !(to > from)) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Give a calendar window whose end is after its start' });
    }
    if (to.getTime() - from.getTime() > 366 * 86_400_000) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'The calendar shows at most a year at a time' });
    }
    return this.prisma.withTenant(tenantId, async (tx) =>
      (
        await tx.eventBooking.findMany({
          // Cancelled events stay on record (their BEO, their notes) but leave the calendar.
          where: { eventSpace: { branchId }, status: 'confirmed', startsAt: { lt: to }, endsAt: { gt: from } },
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
          spaceHireFee: dto.spaceHireFee ? new Prisma.Decimal(dto.spaceHireFee) : null,
          createdBy: actorId,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId: space.branchId,
          userId: actorId,
          action: 'event_booking.created',
          entityType: 'event_booking',
          entityId: booking.id,
          after: { title: dto.title, space: space.name, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), headcount: dto.headcount ?? null },
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
      if (booking.status === 'cancelled') {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This event was cancelled — book it again rather than editing the cancelled one' });
      }
      // What it costs is on a bill now: changing it here would make the two disagree.
      if (booking.billedAt && (dto.catering !== undefined || dto.spaceHireFee !== undefined)) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This event has been billed — correct the charges on the bill instead of changing them here' });
      }

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
          spaceHireFee: dto.spaceHireFee !== undefined ? (dto.spaceHireFee ? new Prisma.Decimal(dto.spaceHireFee) : null) : undefined,
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
      const totals = await this.eventTotals(tx, space.branchId, booking.spaceHireFee, lines);

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
          spaceHire: booking.spaceHireFee && booking.spaceHireFee.greaterThan(0) ? money(booking.spaceHireFee) : null,
          subtotal: money(totals.subtotal),
          tax: money(totals.taxTotal),
          taxIncluded: totals.taxIncluded.isZero() ? null : money(totals.taxIncluded),
          total: money(totals.total),
          avRequirements: booking.avRequirements,
          notes: booking.notes,
        },
      };
    });
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    return { filename: `beo-${slug || 'event'}.pdf`, pdf: await renderBeoPdf(spec) };
  }

  /**
   * A cancelled event is marked, not deleted: its catering, AV notes and BEO
   * stay on record, and the calendar can show that the room was once sold.
   * One click used to hard-delete all of it.
   */
  async cancelBooking(tenantId: string, bookingId: string, actorId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      const booking = await tx.eventBooking.findFirst({ where: { id: bookingId }, include: { eventSpace: { select: { branchId: true, name: true } } } });
      if (!booking) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Event booking not found' });
      if (booking.status === 'cancelled') return;
      await tx.eventBooking.update({ where: { id: bookingId }, data: { status: 'cancelled', cancelledAt: new Date() } });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId: booking.eventSpace.branchId,
          userId: actorId,
          action: 'event_booking.cancelled',
          entityType: 'event_booking',
          entityId: bookingId,
          after: { title: booking.title, space: booking.eventSpace.name, startsAt: booking.startsAt.toISOString() },
        },
      });
    });
  }

  /**
   * Puts the event's space hire and catering on a bill — a guest's, or a
   * group's master bill — at the same property, taxed by the branch's rules
   * like any charge. Once: billed is billed, and a correction is made on the
   * bill.
   */
  async billBooking(tenantId: string, bookingId: string, folioId: string, actor: JwtPayload): Promise<EventBookingDetail> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Two clicks at once would bill it twice.
      await tx.$queryRaw`SELECT id FROM event_bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
      const { booking, space } = await this.loadBooking(tx, bookingId);
      assertRoleAtBranch(actor, space.branchId, EVENT_STAFF_ROLES);
      if (booking.status === 'cancelled') throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This event was cancelled — there is nothing to bill' });
      if (booking.billedAt) throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This event has already been billed' });
      const folio = await tx.folio.findFirst({ where: { id: folioId, deletedAt: null } });
      if (!folio || folio.branchId !== space.branchId) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'No such bill at this property' });
      }
      if (folio.status === 'settled' || folio.status === 'pending') {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: folio.status === 'settled' ? 'That bill is settled — reopen it, or pick an open one' : 'That bill opens when its guest arrives — pick an open one',
        });
      }
      const lines = parseCatering(booking.catering);
      const hire = booking.spaceHireFee && booking.spaceHireFee.greaterThan(0) ? booking.spaceHireFee : null;
      if (!hire && lines.every((line) => !(line.quantity > 0 && line.unitPrice > 0))) {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'This event has no space hire or catering to bill' });
      }

      const branch = await tx.branch.findFirst({ where: { id: space.branchId }, select: { timezone: true } });
      const serviceDate = new Date(`${booking.startsAt.toLocaleDateString('en-CA', { timeZone: branch?.timezone ?? 'UTC' })}T00:00:00.000Z`);
      if (hire) {
        await this.foliosService.postChargeInTx(tx, folio, { description: `${booking.title} — hire of ${space.name}`.slice(0, 300), amount: hire, chargeType: 'misc', serviceDate }, actor.sub);
      }
      for (const line of lines) {
        const amount = new Prisma.Decimal(line.unitPrice).mul(line.quantity);
        if (!amount.greaterThan(0)) continue;
        await this.foliosService.postChargeInTx(
          tx,
          folio,
          { description: `${booking.title} — ${line.description} × ${line.quantity}`.slice(0, 300), amount, chargeType: 'fnb', serviceDate },
          actor.sub,
        );
      }
      const billed = await tx.eventBooking.update({ where: { id: booking.id }, data: { folioId: folio.id, billedAt: new Date(), billedBy: actor.sub } });
      await tx.auditLog.create({
        data: {
          tenantId,
          branchId: space.branchId,
          userId: actor.sub,
          action: 'event_booking.billed',
          entityType: 'event_booking',
          entityId: booking.id,
          after: { folioId: folio.id, title: booking.title, spaceHire: hire?.toFixed(2) ?? null, cateringLines: lines.length },
        },
      });
      return this.detail(tx, billed, space);
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
        status: 'confirmed',
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

  /**
   * A quote, like the Rate Resolver's: the space hire (taxed as a charge of
   * its own) and the catering (by the F&B rules). `subtotal` is the prices
   * added up, `taxTotal` what's added on top, `taxIncluded` what's already
   * inside them — what billing it will post.
   */
  private async eventTotals(tx: TenantTx, branchId: string, spaceHireFee: Prisma.Decimal | null, lines: CateringLine[]) {
    const catering = lines.reduce((sum, line) => sum.plus(new Prisma.Decimal(line.unitPrice).mul(line.quantity)), ZERO);
    const hire = spaceHireFee ?? ZERO;
    const [cateringPriced, hirePriced] = await Promise.all([
      this.taxesService.priceCharge(tx, branchId, 'fnb', catering),
      this.taxesService.priceCharge(tx, branchId, 'misc', hire),
    ]);
    return {
      hire,
      catering,
      subtotal: catering.plus(hire),
      taxTotal: cateringPriced.addedTax.plus(hirePriced.addedTax),
      taxIncluded: cateringPriced.includedTax.plus(hirePriced.includedTax),
      total: cateringPriced.total.plus(hirePriced.total),
    };
  }

  private async detail(tx: TenantTx, booking: EventBooking, space: EventSpace): Promise<EventBookingDetail> {
    const branch = await tx.branch.findFirst({ where: { id: space.branchId }, select: { currency: true } });
    const lines = parseCatering(booking.catering);
    const totals = await this.eventTotals(tx, space.branchId, booking.spaceHireFee, lines);
    const billedFolio = booking.folioId
      ? await tx.folio.findFirst({
          where: { id: booking.folioId },
          select: { id: true, guest: { select: { name: true } }, reservation: { select: { confirmationNumber: true, room: { select: { number: true } } } } },
        })
      : null;
    return {
      ...toBookingSummary(booking),
      space: toSpaceSummary(space),
      currency: branch?.currency ?? '',
      cateringLines: lines.map((line) => ({ ...line, amount: new Prisma.Decimal(line.unitPrice).mul(line.quantity).toFixed(2) })),
      totals: {
        hire: totals.hire.toFixed(2),
        catering: totals.catering.toFixed(2),
        subtotal: totals.subtotal.toFixed(2),
        taxTotal: totals.taxTotal.toFixed(2),
        taxIncluded: totals.taxIncluded.toFixed(2),
        total: totals.total.toFixed(2),
      },
      billedTo: billedFolio
        ? {
            folioId: billedFolio.id,
            guestName: billedFolio.guest.name,
            roomNumber: billedFolio.reservation?.room?.number ?? null,
            confirmationNumber: billedFolio.reservation?.confirmationNumber ?? null,
          }
        : null,
    };
  }
}
