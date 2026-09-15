import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { GroupBlock, Prisma } from '@prisma/client';
import { SystemRole } from '../../common/decorators/roles.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { assertRoleAtBranch } from '../../common/utils/branch-roles';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';
import { BookIntoGroupBlockDto, CreateGroupBlockDto, RoomingListDto } from './dto/sales-events.dto';

const PICKUP_STATUSES = ['confirmed', 'checked_in', 'checked_out'] as const;
const MAX_BLOCK_NIGHTS = 92;
const BOOKING_ROLES = [SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk];
const MANAGER_ROLES = [SystemRole.Owner, SystemRole.Manager];

/**
 * - `holding` — rooms are held out of general sale for the group until the cut-off.
 * - `lapsed` — the cut-off has passed, so unbooked rooms are back on sale. A booking into the block still gets its rate, if a room is free.
 * - `released` — released by hand; it takes no more bookings.
 * - `none` — no stay dates (a block made before holds existed); it holds nothing.
 */
export type GroupBlockHoldState = 'holding' | 'lapsed' | 'released' | 'none';

export interface GroupBlockSummary {
  id: string;
  name: string;
  roomTypeId: string;
  roomTypeName: string;
  blockSize: number;
  blockRate: string;
  arrivalDate: Date | null;
  departureDate: Date | null;
  cutoffDate: Date;
  status: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  pickup: number;
  holdState: GroupBlockHoldState;
  /** The allotment still held for the group (allotment minus its bookings) — 0 unless holding. */
  roomsHeld: number;
  createdAt: Date;
}

export interface RoomingListResult {
  created: Array<{ row: number; guestName: string; confirmationNumber: string; reservationId: string }>;
  failed: Array<{ row: number; guestName: string; message: string }>;
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

function isoDate(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** The message a refused booking gave — what a rooming-list row reports back. */
function messageOf(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    const message = typeof body === 'object' ? (body as { message?: unknown }).message : body;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join(', ');
    return err.message;
  }
  return 'Something went wrong — this guest was not booked';
}

/**
 * Sales & Events' "Group Block Creation" (ref: "allot rooms, set cut-off,
 * track pickup, rooming list upload").
 *
 * A block with stay dates HOLDS rooms: until its cut-off, the allotment it
 * hasn't booked yet is out of general availability for every night of the
 * stay (`ReservationsService.groupBlockHolds`, the one place availability is
 * computed). After the cut-off the hold stops counting and the rooms are back
 * on sale — computed when availability is read, so there's no release job to
 * miss. A booking into the block goes through the ordinary
 * `createReservation`, which links it, applies the block's rate as the
 * reservation's nightly override and lets it use the block's own held rooms,
 * all in one transaction. `pickup` is always counted from real reservations,
 * never stored.
 */
@Injectable()
export class GroupBlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationsService: ReservationsService,
  ) {}

  /**
   * A block can only hold rooms that are free: every night of the stay must
   * have at least `blockSize` rooms of the type available. The room type is
   * locked while this checks and writes — the same lock every booking takes.
   */
  async createBlock(tenantId: string, branchId: string, dto: CreateGroupBlockDto, actorId: string): Promise<GroupBlockSummary> {
    const arrival = toBranchDate(dto.arrivalDate);
    const departure = toBranchDate(dto.departureDate);
    const cutoff = toBranchDate(dto.cutoffDate);
    if (departure <= arrival) throw invalid('The departure date must be after the arrival date');
    if ((departure.getTime() - arrival.getTime()) / 86_400_000 > MAX_BLOCK_NIGHTS) {
      throw invalid(`A block can cover at most ${MAX_BLOCK_NIGHTS} nights`);
    }
    if (cutoff > arrival) throw invalid('The cut-off date must be on or before the arrival date');

    return this.prisma.withTenant(tenantId, async (tx) => {
      const today = await this.branchToday(tx, branchId);
      if (cutoff < today) throw invalid('That cut-off date has already passed');
      const roomType = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, branchId, deletedAt: null } });
      if (!roomType) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room type not found at this branch' });
      }

      await tx.$queryRaw`SELECT id FROM room_types WHERE id = ${roomType.id}::uuid FOR UPDATE`;
      const nights = await this.reservationsService.availabilityPerNightInTx(tx, branchId, roomType.id, arrival, departure);
      const short = nights.find((night) => night.available < dto.blockSize);
      if (short) {
        throw new ConflictException({
          code: ErrorCode.RESERVATION_NOT_AVAILABLE,
          message: `Only ${short.available} ${roomType.name} room${short.available === 1 ? ' is' : 's are'} free on ${short.date} — a block can only hold rooms that are free`,
        });
      }

      const block = await tx.groupBlock.create({
        data: {
          tenantId,
          branchId,
          roomTypeId: roomType.id,
          name: dto.name.trim(),
          blockSize: dto.blockSize,
          blockRate: dto.blockRate,
          arrivalDate: arrival,
          departureDate: departure,
          cutoffDate: cutoff,
          contactName: dto.contactName?.trim() || null,
          contactEmail: dto.contactEmail || null,
          contactPhone: dto.contactPhone?.trim() || null,
          createdBy: actorId,
        },
        include: { roomType: { select: { name: true } } },
      });
      await this.audit(tx, tenantId, branchId, actorId, 'group_block.created', block.id, {
        name: block.name,
        roomTypeId: block.roomTypeId,
        blockSize: block.blockSize,
        blockRate: block.blockRate.toFixed(2),
        arrivalDate: dto.arrivalDate,
        departureDate: dto.departureDate,
        cutoffDate: dto.cutoffDate,
      });
      return this.toSummary(block, 0, today);
    });
  }

  async listBlocks(tenantId: string, branchId: string): Promise<GroupBlockSummary[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const blocks = await tx.groupBlock.findMany({
        where: { branchId },
        orderBy: { createdAt: 'desc' },
        include: { roomType: { select: { name: true } } },
      });
      if (blocks.length === 0) return [];

      const today = await this.branchToday(tx, branchId);
      const pickups = await tx.reservation.groupBy({
        by: ['groupBlockId'],
        where: { groupBlockId: { in: blocks.map((b) => b.id) }, deletedAt: null, status: { in: [...PICKUP_STATUSES] } },
        _count: { _all: true },
      });
      const pickupByBlock = new Map(pickups.map((p) => [p.groupBlockId, p._count._all]));
      return blocks.map((b) => this.toSummary(b, pickupByBlock.get(b.id) ?? 0, today));
    });
  }

  /** Stops the block taking bookings and gives its held rooms back at once. Rooms already booked are unaffected. */
  async releaseBlock(tenantId: string, blockId: string, actor: JwtPayload): Promise<GroupBlockSummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const block = await tx.groupBlock.findFirst({ where: { id: blockId } });
      if (!block) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Group block not found' });
      assertRoleAtBranch(actor, block.branchId, MANAGER_ROLES);
      if (block.status !== 'active') {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: `This block is already ${block.status}` });
      }
      const updated = await tx.groupBlock.update({
        where: { id: blockId },
        data: { status: 'released' },
        include: { roomType: { select: { name: true } } },
      });
      await this.audit(tx, tenantId, block.branchId, actor.sub, 'group_block.released', blockId, { name: block.name });
      const pickup = await this.pickupOf(tx, blockId);
      return this.toSummary(updated, pickup, await this.branchToday(tx, block.branchId));
    });
  }

  async bookIntoBlock(
    tenantId: string,
    blockId: string,
    dto: BookIntoGroupBlockDto,
    actor: JwtPayload,
  ): Promise<{ reservationId: string; confirmationNumber: string }> {
    const block = await this.prisma.withTenant(tenantId, (tx) => tx.groupBlock.findFirst({ where: { id: blockId } }));
    if (!block) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Group block not found' });
    assertRoleAtBranch(actor, block.branchId, BOOKING_ROLES);

    const checkInDate = dto.checkInDate ?? isoDate(block.arrivalDate);
    const checkOutDate = dto.checkOutDate ?? isoDate(block.departureDate);
    if (!checkInDate || !checkOutDate) throw invalid('Give the stay dates — this block has none of its own');

    const reservation = await this.reservationsService.createReservation(
      tenantId,
      block.branchId,
      {
        guestId: dto.guestId,
        guest: dto.guest,
        roomTypeId: block.roomTypeId,
        checkInDate,
        checkOutDate,
        adults: dto.adults,
        children: dto.children,
        specialRequests: dto.specialRequests,
      },
      actor.sub,
      { groupBlockId: block.id },
    );
    return { reservationId: reservation.id, confirmationNumber: reservation.confirmationNumber };
  }

  /**
   * Books a rooming list into the block, one ordinary reservation per guest.
   * Every row is checked before any is booked — a typo shouldn't leave half
   * a list booked — and the list can't be longer than the rooms the block has
   * left. A row the booking itself refuses (a room type that sleeps two, say)
   * is reported with its reason and the rest carry on.
   */
  async importRoomingList(tenantId: string, blockId: string, dto: RoomingListDto, actor: JwtPayload): Promise<RoomingListResult> {
    const { block, pickup } = await this.prisma.withTenant(tenantId, async (tx) => {
      const found = await tx.groupBlock.findFirst({ where: { id: blockId } });
      if (!found) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Group block not found' });
      return { block: found, pickup: await this.pickupOf(tx, blockId) };
    });
    assertRoleAtBranch(actor, block.branchId, BOOKING_ROLES);
    if (block.status !== 'active') {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: `This block is ${block.status}, not accepting reservations` });
    }

    const problems: string[] = [];
    const rows = dto.rows.map((row, index) => {
      const rowNumber = index + 1;
      const guestName = row.guestName.trim();
      const checkInDate = row.checkInDate ?? isoDate(block.arrivalDate);
      const checkOutDate = row.checkOutDate ?? isoDate(block.departureDate);
      if (!guestName) problems.push(`Row ${rowNumber}: the guest's name is missing`);
      if (!checkInDate || !checkOutDate) problems.push(`Row ${rowNumber}: no stay dates, and the block has none to fall back on`);
      else if (checkOutDate <= checkInDate) problems.push(`Row ${rowNumber}: check-out must be after check-in`);
      return { rowNumber, guestName, checkInDate: checkInDate ?? '', checkOutDate: checkOutDate ?? '', row };
    });
    if (problems.length > 0) {
      const more = problems.length > 5 ? ` (and ${problems.length - 5} more)` : '';
      throw invalid(`Nothing was booked. ${problems.slice(0, 5).join('; ')}${more}`);
    }

    const remaining = block.blockSize - pickup;
    if (rows.length > remaining) {
      throw new ConflictException({
        code: ErrorCode.CONFLICT,
        message: `Nothing was booked. The block has ${remaining} of its ${block.blockSize} rooms left, and the list has ${rows.length} guests`,
      });
    }

    const result: RoomingListResult = { created: [], failed: [] };
    for (const { rowNumber, guestName, checkInDate, checkOutDate, row } of rows) {
      try {
        const reservation = await this.reservationsService.createReservation(
          tenantId,
          block.branchId,
          {
            guest: { name: guestName, email: row.email, phone: row.phone?.trim() || undefined },
            roomTypeId: block.roomTypeId,
            checkInDate,
            checkOutDate,
            adults: row.adults ?? 1,
            children: row.children ?? 0,
            specialRequests: row.specialRequests?.trim() || undefined,
          },
          actor.sub,
          { groupBlockId: block.id },
        );
        result.created.push({ row: rowNumber, guestName, confirmationNumber: reservation.confirmationNumber, reservationId: reservation.id });
      } catch (err) {
        result.failed.push({ row: rowNumber, guestName, message: messageOf(err) });
      }
    }

    await this.prisma.withTenant(tenantId, (tx) =>
      this.audit(tx, tenantId, block.branchId, actor.sub, 'group_block.rooming_list_imported', block.id, {
        rows: rows.length,
        booked: result.created.length,
        failed: result.failed.map((f) => ({ row: f.row, message: f.message })),
      }),
    );
    return result;
  }

  // -------------------------------------------------------------------------

  private async branchToday(tx: TenantTx, branchId: string): Promise<Date> {
    const branch = await tx.branch.findFirst({ where: { id: branchId, deletedAt: null }, select: { timezone: true } });
    if (!branch) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Branch not found' });
    return toBranchDate(todayInTimezone(branch.timezone));
  }

  private pickupOf(tx: TenantTx, blockId: string): Promise<number> {
    return tx.reservation.count({ where: { groupBlockId: blockId, deletedAt: null, status: { in: [...PICKUP_STATUSES] } } });
  }

  private toSummary(block: GroupBlock & { roomType: { name: string } }, pickup: number, today: Date): GroupBlockSummary {
    let holdState: GroupBlockHoldState;
    if (block.status !== 'active') holdState = 'released';
    else if (!block.arrivalDate || !block.departureDate) holdState = 'none';
    else holdState = block.cutoffDate >= today ? 'holding' : 'lapsed';

    return {
      id: block.id,
      name: block.name,
      roomTypeId: block.roomTypeId,
      roomTypeName: block.roomType.name,
      blockSize: block.blockSize,
      blockRate: block.blockRate.toFixed(2),
      arrivalDate: block.arrivalDate,
      departureDate: block.departureDate,
      cutoffDate: block.cutoffDate,
      status: block.status,
      contactName: block.contactName,
      contactEmail: block.contactEmail,
      contactPhone: block.contactPhone,
      pickup,
      holdState,
      roomsHeld: holdState === 'holding' ? Math.max(0, block.blockSize - pickup) : 0,
      createdAt: block.createdAt,
    };
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
    await tx.auditLog.create({ data: { tenantId, branchId, userId, action, entityType: 'group_block', entityId, after } });
  }
}
