import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MenuItem, Outlet, Prisma } from '@prisma/client';
import { SystemRole } from '../../common/decorators/roles.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { JwtPayload } from '../../common/types/request-context';
import { branchCutoffInstant, todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { FoliosService } from '../folios/folios.service';
import { PropertyService } from '../property/property.service';
import {
  CreateMenuItemDto,
  CreateOutletDto,
  CreatePosOrderDto,
  OrderItemDto,
  QuotePosOrderDto,
  UpdateMenuItemDto,
  UpdateOutletDto,
  VoidPosOrderDto,
} from './dto/pos.dto';
import { normaliseModifierGroups, OUTLET_CHARGE_TYPES, priceOrder } from './pos-pricing';

const ZERO = new Prisma.Decimal(0);

/** Set up outlets and menus; void a sale. */
const SUPERVISOR_ROLES: string[] = [SystemRole.Owner, SystemRole.Manager];
/** Ring up at any of the branch's outlets. */
const ALL_OUTLET_ROLES: string[] = [SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk];
/** Everyone who works a till. POS staff reach only the outlets they're assigned to (`user_outlets`). */
export const POS_TERMINAL_ROLES = [SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.PosStaff];

const ORDER_INCLUDE = {
  outlet: { select: { id: true, name: true, category: true } },
  branch: { select: { name: true } },
  reservation: {
    select: { id: true, confirmationNumber: true, guest: { select: { name: true } }, room: { select: { number: true } } },
  },
} satisfies Prisma.PosOrderInclude;

type OrderWithContext = Prisma.PosOrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw invalid(`The ${label} can't be blank`);
  return trimmed;
}

/** `[start, end)` of a branch-local calendar day, as instants. */
function businessDayWindow(day: string, timezone: string): { start: Date; end: Date } {
  const date = toBranchDate(day);
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return { start: branchCutoffInstant(date, '00:00:00', timezone), end: branchCutoffInstant(next, '00:00:00', timezone) };
}

/**
 * Point of Sale (growth plan Month 10). A `PosOrder` is the outlet's own sales
 * ledger, whatever settled it. "Charge to room" additionally posts the order
 * as ONE line on the guest's folio, through FoliosService's own charge path —
 * stamped with the outlet, typed by the outlet's category, taxed by the
 * branch's rules — so the guest's bill, its tax, corrections and split
 * billing all work on it unchanged. A cash sale joins the cashier's open
 * shift, so the drawer count at shift close expects it.
 *
 * Walk-in cash and card sales stay OFF the folio ledger deliberately: a folio
 * belongs to a reservation, and a bar customer who isn't staying has none.
 */
@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    private readonly foliosService: FoliosService,
  ) {}

  // -------------------------------------------------------------------------
  // Outlets
  // -------------------------------------------------------------------------

  /**
   * Managers see every outlet, inactive ones included, with who's assigned.
   * Everyone else sees the active outlets they can ring up at — for POS staff
   * only their assigned ones, so a one-outlet bartender's terminal opens
   * straight onto their bar.
   */
  async listOutlets(tenantId: string, branchId: string, actor: JwtPayload) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const supervisor = this.hasRoleAt(actor, branchId, SUPERVISOR_ROLES);
      const where: Prisma.OutletWhereInput = { branchId };
      if (!supervisor) where.isActive = true;
      if (!this.hasRoleAt(actor, branchId, ALL_OUTLET_ROLES)) where.userOutlets = { some: { userId: actor.sub } };

      const outlets = await tx.outlet.findMany({
        where,
        orderBy: [{ sortOrder: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
        include: {
          _count: { select: { menuItems: { where: { deletedAt: null } } } },
          userOutlets: { select: { user: { select: { id: true, name: true } } } },
        },
      });
      return outlets.map(({ _count, userOutlets, ...outlet }) => ({
        ...outlet,
        menuItemCount: _count.menuItems,
        assignedStaff: supervisor ? userOutlets.map((row) => row.user) : undefined,
      }));
    });
  }

  async createOutlet(tenantId: string, branchId: string, dto: CreateOutletDto, actorId: string): Promise<Outlet> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const name = requireText(dto.name, 'outlet name');
      await this.assertOutletNameFree(tx, branchId, name);
      const outlet = await tx.outlet.create({
        data: { tenantId, branchId, name, category: dto.category, chargeType: OUTLET_CHARGE_TYPES[dto.category], sortOrder: dto.sortOrder },
      });
      await this.audit(tx, tenantId, branchId, actorId, 'outlet.created', 'outlet', outlet.id, {
        name,
        category: dto.category,
        chargeType: outlet.chargeType,
      });
      return outlet;
    });
  }

  async updateOutlet(tenantId: string, outletId: string, dto: UpdateOutletDto, actor: JwtPayload): Promise<Outlet> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const outlet = await this.findOutletOrThrow(tx, outletId);
      this.assertSupervisorAt(actor, outlet.branchId);
      const name = dto.name === undefined ? undefined : requireText(dto.name, 'outlet name');
      if (name !== undefined) await this.assertOutletNameFree(tx, outlet.branchId, name, outlet.id);

      const updated = await tx.outlet.update({
        where: { id: outletId },
        data: { name, isActive: dto.isActive, sortOrder: dto.sortOrder },
      });
      await this.audit(tx, tenantId, outlet.branchId, actor.sub, 'outlet.updated', 'outlet', outletId, {
        name: updated.name,
        isActive: updated.isActive,
        sortOrder: updated.sortOrder,
      });
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Menu
  // -------------------------------------------------------------------------

  async listMenu(tenantId: string, outletId: string, actor: JwtPayload) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const outlet = await this.findOutletOrThrow(tx, outletId);
      await this.assertCanRingUp(tx, actor, outlet);
      const branch = await this.propertyService.assertBranch(tx, outlet.branchId);
      const items = await tx.menuItem.findMany({
        where: { outletId, deletedAt: null },
        orderBy: [{ sortOrder: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      });
      return { outlet, currency: branch.currency, items };
    });
  }

  async createMenuItem(tenantId: string, outletId: string, dto: CreateMenuItemDto, actor: JwtPayload): Promise<MenuItem> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const outlet = await this.findOutletOrThrow(tx, outletId);
      this.assertSupervisorAt(actor, outlet.branchId);
      const item = await tx.menuItem.create({
        data: {
          tenantId,
          branchId: outlet.branchId,
          outletId,
          name: requireText(dto.name, 'item name'),
          category: requireText(dto.category, 'category'),
          price: new Prisma.Decimal(dto.price),
          isAvailable: dto.isAvailable ?? true,
          sortOrder: dto.sortOrder,
          modifiers: normaliseModifierGroups(dto.modifiers ?? []),
        },
      });
      await this.audit(tx, tenantId, outlet.branchId, actor.sub, 'menu_item.created', 'menu_item', item.id, {
        outletId,
        name: item.name,
        price: item.price.toFixed(2),
      });
      return item;
    });
  }

  async updateMenuItem(tenantId: string, itemId: string, dto: UpdateMenuItemDto, actor: JwtPayload): Promise<MenuItem> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const item = await this.findMenuItemOrThrow(tx, itemId);
      this.assertSupervisorAt(actor, item.branchId);
      const updated = await tx.menuItem.update({
        where: { id: itemId },
        data: {
          name: dto.name === undefined ? undefined : requireText(dto.name, 'item name'),
          category: dto.category === undefined ? undefined : requireText(dto.category, 'category'),
          price: dto.price === undefined ? undefined : new Prisma.Decimal(dto.price),
          isAvailable: dto.isAvailable,
          sortOrder: dto.sortOrder,
          modifiers: dto.modifiers === undefined ? undefined : normaliseModifierGroups(dto.modifiers),
        },
      });
      await this.audit(tx, tenantId, item.branchId, actor.sub, 'menu_item.updated', 'menu_item', itemId, {
        name: updated.name,
        priceBefore: item.price.toFixed(2),
        price: updated.price.toFixed(2),
        isAvailable: updated.isAvailable,
      });
      return updated;
    });
  }

  /** 86'ing an item is a call made on the floor, not a menu change — anyone working the outlet's till can make it. */
  async setAvailability(tenantId: string, itemId: string, isAvailable: boolean, actor: JwtPayload): Promise<MenuItem> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const item = await this.findMenuItemOrThrow(tx, itemId);
      await this.assertCanRingUp(tx, actor, await this.findOutletOrThrow(tx, item.outletId));
      const updated = await tx.menuItem.update({ where: { id: itemId }, data: { isAvailable } });
      await this.audit(tx, tenantId, item.branchId, actor.sub, isAvailable ? 'menu_item.available' : 'menu_item.unavailable', 'menu_item', itemId, {
        name: item.name,
      });
      return updated;
    });
  }

  /** Soft delete. Past orders carry their own snapshot of what was sold, so none of them change. */
  async deleteMenuItem(tenantId: string, itemId: string, actor: JwtPayload): Promise<MenuItem> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const item = await this.findMenuItemOrThrow(tx, itemId);
      this.assertSupervisorAt(actor, item.branchId);
      const deleted = await tx.menuItem.update({ where: { id: itemId }, data: { deletedAt: new Date() } });
      await this.audit(tx, tenantId, item.branchId, actor.sub, 'menu_item.deleted', 'menu_item', itemId, { name: item.name });
      return deleted;
    });
  }

  // -------------------------------------------------------------------------
  // Selling
  // -------------------------------------------------------------------------

  /** The basket's price, modifiers and tax included — the terminal shows this and never adds anything up itself. */
  async quote(tenantId: string, outletId: string, dto: QuotePosOrderDto, actor: JwtPayload) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const outlet = await this.findOutletOrThrow(tx, outletId);
      this.assertOutletActive(outlet);
      await this.assertCanRingUp(tx, actor, outlet);
      const branch = await this.propertyService.assertBranch(tx, outlet.branchId);
      const priced = await this.priceBasket(tx, outlet, dto.items);
      return {
        currency: branch.currency,
        lines: priced.lines,
        subtotal: priced.subtotal,
        taxTotal: priced.taxTotal,
        total: priced.subtotal.plus(priced.taxTotal),
      };
    });
  }

  /**
   * "Charge to room" starts here: the cashier enters the room number and reads
   * the guest's name back before charging. Only a checked-in stay can be charged.
   */
  async roomLookup(tenantId: string, branchId: string, roomNumber: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const number = roomNumber.trim();
      const reservation = await tx.reservation.findFirst({
        where: { branchId, status: 'checked_in', deletedAt: null, room: { number } },
        orderBy: { actualCheckIn: 'desc' },
        include: { guest: { select: { name: true } }, room: { select: { number: true } } },
      });
      if (!reservation) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: `No guest is checked in to room ${number}` });
      }
      const folio = await tx.folio.findFirst({
        where: { reservationId: reservation.id, label: null, deletedAt: null },
        select: { status: true },
      });
      return {
        reservationId: reservation.id,
        guestName: reservation.guest.name,
        roomNumber: reservation.room?.number ?? number,
        checkOutDate: reservation.checkOutDate,
        // A settled bill takes no new charges until the desk reopens it.
        billClosed: folio?.status === 'settled',
      };
    });
  }

  async createOrder(tenantId: string, dto: CreatePosOrderDto, actor: JwtPayload) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const outlet = await this.findOutletOrThrow(tx, dto.outletId);
      this.assertOutletActive(outlet);
      await this.assertCanRingUp(tx, actor, outlet);
      const branch = await this.propertyService.assertBranch(tx, outlet.branchId);

      if (dto.settlement === 'room' && !dto.reservationId) {
        throw invalid('Look the room up first — a room charge needs the guest it goes to');
      }
      if (dto.settlement !== 'room' && dto.reservationId) {
        throw invalid("A cash or card sale isn't charged to a room — leave the guest out");
      }

      // Numbers orders per outlet. The row lock queues two tills at the same
      // bar, so they can't both take #42; the unique index backs it up.
      await tx.$queryRaw`SELECT id FROM outlets WHERE id = ${outlet.id}::uuid FOR UPDATE`;
      const last = await tx.posOrder.aggregate({ _max: { orderNo: true }, where: { outletId: outlet.id } });
      const orderNo = (last._max.orderNo ?? 0) + 1;

      const priced = await this.priceBasket(tx, outlet, dto.items);
      if (!priced.subtotal.greaterThan(0)) throw invalid("This order comes to nothing — there's nothing to charge");

      let taxTotal = priced.taxTotal;
      let room: { reservationId: string; folioId: string; lineItemId: string } | null = null;
      let shiftId: string | null = null;

      if (dto.settlement === 'room') {
        const reservation = await tx.reservation.findFirst({
          where: { id: dto.reservationId, branchId: outlet.branchId, deletedAt: null },
        });
        if (!reservation) {
          throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Reservation not found' });
        }
        if (reservation.status !== 'checked_in') {
          throw new ConflictException({ code: ErrorCode.CONFLICT, message: "This guest isn't checked in any more — take cash or card instead" });
        }
        const folio = await this.foliosService.ensurePrimaryFolio(tx, reservation, actor.sub);
        if (folio.status === 'settled') {
          throw new ConflictException({
            code: ErrorCode.CONFLICT,
            message: "This guest's bill has been settled and closed — ask the front desk to reopen it, or take cash or card",
          });
        }
        const summary = priced.lines.map((line) => `${line.qty}× ${line.name}`).join(', ');
        const lineItem = await this.foliosService.postOutletCharge(tx, {
          folio,
          outletId: outlet.id,
          chargeType: outlet.chargeType,
          amount: priced.subtotal,
          description: `${outlet.name} — Order #${orderNo}: ${summary}`.slice(0, 300),
          serviceDate: toBranchDate(todayInTimezone(branch.timezone)),
          actorId: actor.sub,
        });
        if (!lineItem) throw invalid("This order comes to nothing — there's nothing to charge");
        // The ledger's own tax figure. The quote used the same rules and
        // rounding, so the two agree; reading it back makes that certain.
        taxTotal = lineItem.taxAmount;
        room = { reservationId: reservation.id, folioId: folio.id, lineItemId: lineItem.id };
      } else if (dto.settlement === 'cash') {
        // Into the drawer of the cashier's own open shift, the rule a cash
        // folio payment follows (FoliosService.recordPayment).
        const shift = await tx.shift.findFirst({
          where: { branchId: outlet.branchId, agentId: actor.sub, closedAt: null },
          select: { id: true },
        });
        shiftId = shift?.id ?? null;
      }

      const tableNumber = dto.tableNumber?.trim();
      const order = await tx.posOrder.create({
        data: {
          tenantId,
          branchId: outlet.branchId,
          outletId: outlet.id,
          orderNo,
          settlement: dto.settlement,
          tableNumber: tableNumber ? tableNumber : null,
          items: priced.lines,
          subtotal: priced.subtotal,
          taxTotal,
          total: priced.subtotal.plus(taxTotal),
          currency: branch.currency,
          reservationId: room?.reservationId,
          folioId: room?.folioId,
          lineItemId: room?.lineItemId,
          shiftId,
          createdBy: actor.sub,
        },
        include: ORDER_INCLUDE,
      });
      await this.audit(tx, tenantId, outlet.branchId, actor.sub, 'pos_order.created', 'pos_order', order.id, {
        outletId: outlet.id,
        orderNo,
        settlement: dto.settlement,
        total: order.total.toFixed(2),
        lineItemId: room?.lineItemId ?? null,
        shiftId,
      });
      const [presented] = await this.present(tx, [order]);
      return presented;
    });
  }

  /** One business day of an outlet's sales, newest first, with the day's takings by settlement (voids left out). */
  async listOrders(tenantId: string, outletId: string, date: string | undefined, actor: JwtPayload) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const outlet = await this.findOutletOrThrow(tx, outletId);
      await this.assertCanRingUp(tx, actor, outlet);
      const branch = await this.propertyService.assertBranch(tx, outlet.branchId);
      const day = date ?? todayInTimezone(branch.timezone);
      const { start, end } = businessDayWindow(day, branch.timezone);

      const orders = await tx.posOrder.findMany({
        where: { outletId, createdAt: { gte: start, lt: end } },
        orderBy: { orderNo: 'desc' },
        include: ORDER_INCLUDE,
      });

      const summary = { orderCount: 0, voidCount: 0, total: ZERO, room: ZERO, cash: ZERO, card: ZERO };
      for (const order of orders) {
        if (order.voidedAt) {
          summary.voidCount++;
          continue;
        }
        summary.orderCount++;
        summary.total = summary.total.plus(order.total);
        summary[order.settlement] = summary[order.settlement].plus(order.total);
      }
      return { date: day, currency: branch.currency, summary, orders: await this.present(tx, orders) };
    });
  }

  async getOrder(tenantId: string, orderId: string, actor: JwtPayload) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const order = await tx.posOrder.findFirst({ where: { id: orderId }, include: ORDER_INCLUDE });
      if (!order) throw this.orderNotFound();
      await this.assertCanRingUp(tx, actor, await this.findOutletOrThrow(tx, order.outletId));
      const [presented] = await this.present(tx, [order]);
      return presented;
    });
  }

  /**
   * Managers only. A room charge comes off the guest's bill through the
   * folio's own correction — tax and all — unless someone already corrected
   * that line from the folio. A cash sale can be voided only while its drawer
   * is still open: once the shift is closed and counted, its figures stand.
   */
  async voidOrder(tenantId: string, orderId: string, dto: VoidPosOrderDto, actor: JwtPayload) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const order = await tx.posOrder.findFirst({ where: { id: orderId } });
      if (!order) throw this.orderNotFound();
      this.assertSupervisorAt(actor, order.branchId);

      if (order.settlement === 'cash' && order.shiftId) {
        const shift = await tx.shift.findFirst({ where: { id: order.shiftId }, select: { closedAt: true } });
        if (shift?.closedAt) {
          throw new ConflictException({
            code: ErrorCode.CONFLICT,
            message: "The shift this cash went into has been closed and counted — the sale can't be voided now",
          });
        }
      }

      const reason = requireText(dto.reason, 'reason');
      // Claim the void first. Of two managers voiding at once, the second
      // waits on the row and then finds it already voided, before it can
      // touch the guest's bill.
      const claimed = await tx.posOrder.updateMany({
        where: { id: orderId, voidedAt: null },
        data: { voidedAt: new Date(), voidedBy: actor.sub, voidReason: reason },
      });
      if (claimed.count === 0) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This order has already been voided' });
      }

      let correctionId: string | null = null;
      if (order.lineItemId) {
        const existing = await tx.lineItem.findFirst({ where: { correctsLineItemId: order.lineItemId }, select: { id: true } });
        if (!existing) {
          const correction = await this.foliosService.correctLineItemInTx(
            tx,
            tenantId,
            order.lineItemId,
            `Void of order #${order.orderNo}: ${reason}`,
            actor.sub,
          );
          correctionId = correction.id;
        }
      }

      await this.audit(tx, tenantId, order.branchId, actor.sub, 'pos_order.voided', 'pos_order', orderId, {
        orderNo: order.orderNo,
        settlement: order.settlement,
        total: order.total.toFixed(2),
        reason,
        correctionLineItemId: correctionId,
      });
      const updated = await tx.posOrder.findFirstOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
      const [presented] = await this.present(tx, [updated]);
      return presented;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async priceBasket(tx: TenantTx, outlet: Outlet, items: OrderItemDto[]) {
    const menuItems = await tx.menuItem.findMany({
      where: { outletId: outlet.id, id: { in: items.map((item) => item.menuItemId) }, deletedAt: null },
    });
    const { lines, subtotal } = priceOrder(menuItems, items);
    const taxTotal = await this.foliosService.previewTaxTotal(tx, outlet.branchId, outlet.chargeType, subtotal);
    return { lines, subtotal, taxTotal };
  }

  /** Adds who rang each sale up — the receipt's "Served by". */
  private async present(tx: TenantTx, orders: OrderWithContext[]) {
    const ids = [...new Set(orders.map((order) => order.createdBy).filter((id): id is string => id !== null))];
    const users = ids.length > 0 ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((user) => [user.id, user.name]));
    return orders.map((order) => ({ ...order, cashierName: order.createdBy ? (names.get(order.createdBy) ?? null) : null }));
  }

  private hasRoleAt(actor: JwtPayload, branchId: string, roles: string[]): boolean {
    return actor.roles.some((r) => roles.includes(r.role) && (r.branchId === null || r.branchId === branchId));
  }

  /**
   * The route guards pass a role held at ANY branch when the URL names no
   * branch, so every route addressed by outlet, item or order checks the
   * role at that record's own branch here.
   */
  private assertSupervisorAt(actor: JwtPayload, branchId: string): void {
    if (!this.hasRoleAt(actor, branchId, SUPERVISOR_ROLES)) {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Insufficient role for this action' });
    }
  }

  private async assertCanRingUp(tx: TenantTx, actor: JwtPayload, outlet: Outlet): Promise<void> {
    if (this.hasRoleAt(actor, outlet.branchId, ALL_OUTLET_ROLES)) return;
    if (this.hasRoleAt(actor, outlet.branchId, [SystemRole.PosStaff])) {
      const assigned = await tx.userOutlet.findFirst({ where: { userId: actor.sub, outletId: outlet.id }, select: { id: true } });
      if (assigned) return;
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: `You aren't assigned to ${outlet.name} — ask a manager to add you` });
    }
    throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Insufficient role for this action' });
  }

  private assertOutletActive(outlet: Outlet): void {
    if (!outlet.isActive) {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: `${outlet.name} is marked inactive — a manager can reopen it` });
    }
  }

  private async assertOutletNameFree(tx: TenantTx, branchId: string, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.outlet.findFirst({
      where: { branchId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: `This branch already has an outlet called "${name}"` });
    }
  }

  private async findOutletOrThrow(tx: TenantTx, outletId: string): Promise<Outlet> {
    const outlet = await tx.outlet.findFirst({ where: { id: outletId } });
    if (!outlet) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Outlet not found' });
    return outlet;
  }

  private async findMenuItemOrThrow(tx: TenantTx, itemId: string): Promise<MenuItem> {
    const item = await tx.menuItem.findFirst({ where: { id: itemId, deletedAt: null } });
    if (!item) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Menu item not found' });
    return item;
  }

  private orderNotFound(): NotFoundException {
    return new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Order not found' });
  }

  private async audit(
    tx: TenantTx,
    tenantId: string,
    branchId: string,
    userId: string,
    action: string,
    entityType: string,
    entityId: string,
    after?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, branchId, userId, action, entityType, entityId, after } });
  }
}
