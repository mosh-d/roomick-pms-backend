import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { FoliosService } from '../folios/folios.service';
import { PropertyService } from '../property/property.service';
import { CreatePosOrderDto } from './dto/pos.dto';
import { PosService } from './pos.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_BRANCH_ID = '99999999-9999-4999-8999-999999999999';
const OUTLET_ID = '33333333-3333-4333-8333-333333333333';
const ITEM_ID = '44444444-4444-4444-8444-444444444444';
const RESERVATION_ID = '55555555-5555-4555-8555-555555555555';
const FOLIO_ID = '66666666-6666-4666-8666-666666666666';
const LINE_ITEM_ID = '77777777-7777-4777-8777-777777777777';
const SHIFT_ID = '88888888-8888-4888-8888-888888888888';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function actor(role: string, branchId: string | null = BRANCH_ID): JwtPayload {
  return { sub: USER_ID, tenantId: TENANT_ID, email: 'staff@example.com', roles: [{ branchId, role }], tokenType: 'access' };
}

const OUTLET = {
  id: OUTLET_ID,
  tenantId: TENANT_ID,
  branchId: BRANCH_ID,
  name: 'Poolside Bar',
  category: 'bar',
  chargeType: 'fnb',
  isActive: true,
  sortOrder: null,
  createdAt: new Date(),
};
const CHAPMAN = { id: ITEM_ID, outletId: OUTLET_ID, branchId: BRANCH_ID, name: 'Chapman', price: new Prisma.Decimal('2500'), isAvailable: true, modifiers: [] };

type Data = { data: Record<string, unknown> };

function makeTx() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    outlet: {
      findFirst: jest.fn().mockResolvedValue(OUTLET),
      create: jest.fn().mockImplementation(({ data }: Data) => Promise.resolve({ id: OUTLET_ID, ...data })),
    },
    menuItem: { findMany: jest.fn().mockResolvedValue([CHAPMAN]) },
    posOrder: {
      aggregate: jest.fn().mockResolvedValue({ _max: { orderNo: 41 } }),
      create: jest.fn().mockImplementation(({ data }: Data) => Promise.resolve({ id: ORDER_ID, ...data })),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: ORDER_ID, createdBy: USER_ID }),
    },
    reservation: { findFirst: jest.fn().mockResolvedValue({ id: RESERVATION_ID, branchId: BRANCH_ID, status: 'checked_in' }) },
    shift: { findFirst: jest.fn().mockResolvedValue({ id: SHIFT_ID }) },
    lineItem: { findFirst: jest.fn().mockResolvedValue(null) },
    userOutlet: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: USER_ID, name: 'Ada' }]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

function makeFolios() {
  return {
    ensurePrimaryFolio: jest.fn().mockResolvedValue({ id: FOLIO_ID, status: 'open' }),
    postOutletCharge: jest.fn().mockResolvedValue({ id: LINE_ITEM_ID, taxAmount: new Prisma.Decimal('375') }),
    previewTaxTotal: jest.fn().mockResolvedValue(new Prisma.Decimal('375')),
    correctLineItemInTx: jest.fn().mockResolvedValue({ id: 'correction-1' }),
  };
}

const TWO_CHAPMANS = { outletId: OUTLET_ID, items: [{ menuItemId: ITEM_ID, qty: 2 }] };

describe('PosService', () => {
  let service: PosService;
  let tx: ReturnType<typeof makeTx>;
  let folios: ReturnType<typeof makeFolios>;

  beforeEach(async () => {
    tx = makeTx();
    folios = makeFolios();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PosService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: PropertyService, useValue: { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, currency: 'NGN', timezone: 'Africa/Lagos' }) } },
        { provide: FoliosService, useValue: folios },
      ],
    }).compile();
    service = moduleRef.get(PosService);
  });

  const createdOrder = () => (tx.posOrder.create.mock.calls[0] as [Data])[0].data;
  const order = (dto: Partial<CreatePosOrderDto>, who = actor('front_desk')) =>
    service.createOrder(TENANT_ID, { ...TWO_CHAPMANS, settlement: 'cash', ...dto }, who);

  describe('createOrder — charge to room', () => {
    it("posts the order as one line on the guest's folio, stamped with the outlet, and links the order to it", async () => {
      const result = await order({ settlement: 'room', reservationId: RESERVATION_ID });

      expect(tx.$queryRaw).toHaveBeenCalled(); // the per-outlet numbering lock
      expect(folios.postOutletCharge).toHaveBeenCalledTimes(1);
      const [, posted] = folios.postOutletCharge.mock.calls[0] as [unknown, { outletId: string; chargeType: string; amount: Prisma.Decimal; description: string }];
      expect(posted).toMatchObject({ outletId: OUTLET_ID, chargeType: 'fnb', description: 'Poolside Bar — Order #42: 2× Chapman' });
      expect(posted.amount.toFixed(2)).toBe('5000.00');

      expect(createdOrder()).toMatchObject({ orderNo: 42, settlement: 'room', reservationId: RESERVATION_ID, folioId: FOLIO_ID, lineItemId: LINE_ITEM_ID, shiftId: null });
      expect((createdOrder().taxTotal as Prisma.Decimal).toFixed(2)).toBe('375.00');
      expect((createdOrder().total as Prisma.Decimal).toFixed(2)).toBe('5375.00');
      expect(result.cashierName).toBe('Ada');
    });

    it("refuses a guest who isn't checked in, before anything is posted", async () => {
      tx.reservation.findFirst.mockResolvedValue({ id: RESERVATION_ID, branchId: BRANCH_ID, status: 'checked_out' });
      await expect(order({ settlement: 'room', reservationId: RESERVATION_ID })).rejects.toThrow(ConflictException);
      expect(folios.postOutletCharge).not.toHaveBeenCalled();
      expect(tx.posOrder.create).not.toHaveBeenCalled();
    });

    it('refuses a settled bill instead of posting onto it', async () => {
      folios.ensurePrimaryFolio.mockResolvedValue({ id: FOLIO_ID, status: 'settled' });
      await expect(order({ settlement: 'room', reservationId: RESERVATION_ID })).rejects.toThrow(ConflictException);
      expect(folios.postOutletCharge).not.toHaveBeenCalled();
    });

    it('needs the looked-up guest; cash and card never carry one', async () => {
      await expect(order({ settlement: 'room' })).rejects.toThrow(BadRequestException);
      await expect(order({ settlement: 'cash', reservationId: RESERVATION_ID })).rejects.toThrow(BadRequestException);
    });
  });

  describe('createOrder — cash and card', () => {
    it("puts a cash sale in the cashier's open shift and keeps it off every folio", async () => {
      await order({ settlement: 'cash' });
      expect(tx.shift.findFirst).toHaveBeenCalledWith({ where: { branchId: BRANCH_ID, agentId: USER_ID, closedAt: null }, select: { id: true } });
      expect(createdOrder()).toMatchObject({ settlement: 'cash', shiftId: SHIFT_ID, reservationId: undefined, lineItemId: undefined });
      expect((createdOrder().total as Prisma.Decimal).toFixed(2)).toBe('5375.00'); // the quote's own tax preview
      expect(folios.postOutletCharge).not.toHaveBeenCalled();
    });

    it('never ties a card sale to a drawer', async () => {
      await order({ settlement: 'card' });
      expect(tx.shift.findFirst).not.toHaveBeenCalled();
      expect(createdOrder()).toMatchObject({ settlement: 'card', shiftId: null });
    });

    it('refuses an inactive outlet', async () => {
      tx.outlet.findFirst.mockResolvedValue({ ...OUTLET, isActive: false });
      await expect(order({})).rejects.toThrow(ConflictException);
    });
  });

  describe('outlet access', () => {
    it("keeps POS staff to the outlets they're assigned to", async () => {
      await expect(order({}, actor('pos_staff'))).rejects.toThrow(ForbiddenException);

      tx.userOutlet.findFirst.mockResolvedValue({ id: 'assignment-1' });
      await expect(order({}, actor('pos_staff'))).resolves.toBeDefined();
    });

    it("checks a manager's role at the outlet's own branch, not just anywhere", async () => {
      tx.posOrder.findFirst.mockResolvedValue({ id: ORDER_ID, branchId: BRANCH_ID, settlement: 'card', shiftId: null, lineItemId: null });
      await expect(service.voidOrder(TENANT_ID, ORDER_ID, { reason: 'Wrong order' }, actor('manager', OTHER_BRANCH_ID))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('voidOrder', () => {
    const roomOrder = { id: ORDER_ID, branchId: BRANCH_ID, orderNo: 42, settlement: 'room', lineItemId: LINE_ITEM_ID, shiftId: null, total: new Prisma.Decimal('5375') };

    it("claims the void, then takes the charge off the guest's bill through the folio's correction", async () => {
      tx.posOrder.findFirst.mockResolvedValue(roomOrder);
      await service.voidOrder(TENANT_ID, ORDER_ID, { reason: 'Wrong room' }, actor('manager'));

      expect(tx.posOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ORDER_ID, voidedAt: null } }));
      expect(folios.correctLineItemInTx).toHaveBeenCalledWith(tx, TENANT_ID, LINE_ITEM_ID, 'Void of order #42: Wrong room', USER_ID);
      expect(tx.posOrder.updateMany.mock.invocationCallOrder[0]).toBeLessThan(folios.correctLineItemInTx.mock.invocationCallOrder[0]);
    });

    it('does not reverse a line someone already corrected from the folio', async () => {
      tx.posOrder.findFirst.mockResolvedValue(roomOrder);
      tx.lineItem.findFirst.mockResolvedValue({ id: 'earlier-correction' });
      await service.voidOrder(TENANT_ID, ORDER_ID, { reason: 'Wrong room' }, actor('manager'));
      expect(folios.correctLineItemInTx).not.toHaveBeenCalled();
    });

    it('refuses a second void without touching the bill', async () => {
      tx.posOrder.findFirst.mockResolvedValue(roomOrder);
      tx.posOrder.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.voidOrder(TENANT_ID, ORDER_ID, { reason: 'Wrong room' }, actor('manager'))).rejects.toThrow(ConflictException);
      expect(folios.correctLineItemInTx).not.toHaveBeenCalled();
    });

    it("leaves a closed shift's cash alone", async () => {
      tx.posOrder.findFirst.mockResolvedValue({ ...roomOrder, settlement: 'cash', lineItemId: null, shiftId: SHIFT_ID });
      tx.shift.findFirst.mockResolvedValue({ closedAt: new Date() });
      await expect(service.voidOrder(TENANT_ID, ORDER_ID, { reason: 'Rang it twice' }, actor('manager'))).rejects.toThrow(ConflictException);
      expect(tx.posOrder.updateMany).not.toHaveBeenCalled();
    });

    it('is for managers only', async () => {
      tx.posOrder.findFirst.mockResolvedValue(roomOrder);
      await expect(service.voidOrder(TENANT_ID, ORDER_ID, { reason: 'Wrong room' }, actor('front_desk'))).rejects.toThrow(ForbiddenException);
    });
  });

  describe('createOutlet', () => {
    it("derives the charge type from the outlet's category", async () => {
      tx.outlet.findFirst.mockResolvedValue(null); // no name clash
      await service.createOutlet(TENANT_ID, BRANCH_ID, { name: ' Zen Spa ', category: 'spa' }, USER_ID);
      expect((tx.outlet.create.mock.calls[0] as [Data])[0].data).toMatchObject({ name: 'Zen Spa', category: 'spa', chargeType: 'spa' });
    });

    it('refuses a second outlet with the same name at the branch', async () => {
      await expect(service.createOutlet(TENANT_ID, BRANCH_ID, { name: 'poolside bar', category: 'bar' }, USER_ID)).rejects.toThrow(ConflictException);
    });
  });
});
