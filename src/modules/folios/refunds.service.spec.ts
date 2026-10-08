import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { WebhookEventsService } from '../integrations/webhook-events.service';
import { FoliosService } from './folios.service';
import { RefundsService } from './refunds.service';

/** Webhook events are raised from the same audit calls these tests exercise; what they send is `WebhookEventsService`'s own spec. */
const webhookEvents = { reservationChanged: jest.fn().mockResolvedValue(undefined), paymentRecorded: jest.fn().mockResolvedValue(undefined) };

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const FOLIO_ID = '99999999-9999-4999-8999-999999999999';

const desk = { sub: 'desk-1', tenantId: TENANT_ID, email: 'd@x.com', roles: [{ branchId: BRANCH_ID, role: 'front_desk' }], tokenType: 'access' as const };
const manager = { ...desk, sub: 'mgr-1', roles: [{ branchId: BRANCH_ID, role: 'manager' }] };
const d = (v: string | number) => new Prisma.Decimal(v);

function makeTx() {
  return {
    folio: { findFirst: jest.fn().mockResolvedValue({ id: FOLIO_ID, branchId: BRANCH_ID }) },
    payment: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'pay-out-1', ...data })),
    },
    refund: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'refund-1', ...data })),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'refund-1', ...data })),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
    },
    shift: { findFirst: jest.fn().mockResolvedValue({ id: 'shift-1' }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('RefundsService', () => {
  let service: RefundsService;
  let tx: ReturnType<typeof makeTx>;
  let totals: jest.Mock;

  beforeEach(async () => {
    tx = makeTx();
    // The bill: paid 50,000 against 30,000 of charges — 20,000 in credit.
    totals = jest.fn().mockResolvedValue({ balanceDue: d(-20000) });
    const moduleRef = await Test.createTestingModule({
      providers: [
        RefundsService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        {
          provide: FoliosService,
          useValue: {
            totalsInTx: totals,
            shiftRequired: () => new ConflictException({ code: 'SHIFT_REQUIRED', message: 'Open a shift before taking cash — it has to go into a drawer that gets counted at close' }),
          },
        },
        { provide: PropertyService, useValue: { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, currency: 'NGN' }) } },
        { provide: WebhookEventsService, useValue: webhookEvents },
      ],
    }).compile();
    service = moduleRef.get(RefundsService);
  });

  describe('request', () => {
    it('the desk asks; it waits for a manager', async () => {
      const refund = await service.request(TENANT_ID, FOLIO_ID, { amount: 15000, method: 'cash', reason: 'Overpaid deposit' }, desk);
      expect(refund).toMatchObject({ status: 'pending', approvedBy: null, method: 'cash', requestedBy: 'desk-1' });
    });

    it("a manager's own request is approved as it's made", async () => {
      const refund = await service.request(TENANT_ID, FOLIO_ID, { amount: 15000, method: 'cash', reason: 'Overpaid deposit' }, manager);
      expect(refund).toMatchObject({ status: 'approved', approvedBy: 'mgr-1' });
    });

    it('never more than the bill holds in credit, less refunds already on their way', async () => {
      tx.refund.aggregate.mockResolvedValueOnce({ _sum: { amount: d(10000) } });
      await expect(service.request(TENANT_ID, FOLIO_ID, { amount: 15000, method: 'cash', reason: 'x' }, desk)).rejects.toThrow(/Only 10000.00/);
    });

    it('says so when all of the credit already has a refund on its way', async () => {
      tx.refund.aggregate.mockResolvedValueOnce({ _sum: { amount: d(20000) } });
      await expect(service.request(TENANT_ID, FOLIO_ID, { amount: 1, method: 'cash', reason: 'x' }, desk)).rejects.toThrow(/already has a refund on its way/);
    });

    it('a bill in debt has nothing to refund', async () => {
      totals.mockResolvedValueOnce({ balanceDue: d(5000) });
      await expect(service.request(TENANT_ID, FOLIO_ID, { amount: 100, method: 'cash', reason: 'x' }, desk)).rejects.toThrow(/holds no credit/);
    });

    it("goes back by the original payment's method unless told otherwise", async () => {
      tx.payment.findFirst.mockResolvedValueOnce({ id: 'pay-1', method: 'card', amount: d(50000) });
      const refund = await service.request(TENANT_ID, FOLIO_ID, { amount: 15000, paymentId: 'pay-1', reason: 'x' }, desk);
      expect(refund).toMatchObject({ method: 'card', paymentId: 'pay-1' });
    });

    it('never more than is left of the payment named', async () => {
      tx.payment.findFirst.mockResolvedValueOnce({ id: 'pay-1', method: 'card', amount: d(12000) });
      tx.refund.aggregate.mockResolvedValueOnce({ _sum: { amount: null } }).mockResolvedValueOnce({ _sum: { amount: d(5000) } });
      await expect(service.request(TENANT_ID, FOLIO_ID, { amount: 10000, paymentId: 'pay-1', reason: 'x' }, desk)).rejects.toThrow(/only 7000.00 left/);
    });

    it('points and vouchers are not refunded as money', async () => {
      tx.payment.findFirst.mockResolvedValueOnce({ id: 'pay-1', method: 'loyalty_points', amount: d(5000) });
      await expect(service.request(TENANT_ID, FOLIO_ID, { amount: 1000, paymentId: 'pay-1', reason: 'x' }, desk)).rejects.toThrow(BadRequestException);
    });

    it('needs a method when no payment is named', async () => {
      await expect(service.request(TENANT_ID, FOLIO_ID, { amount: 1000, reason: 'x' }, desk)).rejects.toThrow(/how the money goes back/);
    });
  });

  describe('approve, reject, pay out', () => {
    const refund = (overrides: Record<string, unknown> = {}) => ({
      id: 'refund-1',
      folioId: FOLIO_ID,
      amount: d(15000),
      method: 'cash',
      reason: 'Overpaid deposit',
      status: 'pending',
      folio: { branchId: BRANCH_ID },
      ...overrides,
    });

    it('approval re-checks the credit — the bill may have changed since', async () => {
      tx.refund.findFirst.mockResolvedValueOnce(refund());
      totals.mockResolvedValueOnce({ balanceDue: d(-5000) });
      await expect(service.approve(TENANT_ID, 'refund-1', manager)).rejects.toThrow(ConflictException);
      expect(tx.refund.update).not.toHaveBeenCalled();
    });

    it('approves a waiting refund', async () => {
      tx.refund.findFirst.mockResolvedValueOnce(refund());
      await service.approve(TENANT_ID, 'refund-1', manager);
      expect(tx.refund.update).toHaveBeenCalledWith({ where: { id: 'refund-1' }, data: { status: 'approved', approvedBy: 'mgr-1' } });
    });

    it('turns one down with the reason, before it is paid out', async () => {
      tx.refund.findFirst.mockResolvedValueOnce(refund({ status: 'approved' }));
      await service.reject(TENANT_ID, 'refund-1', ' Took it as a discount ', manager);
      expect(tx.refund.update).toHaveBeenCalledWith({ where: { id: 'refund-1' }, data: { status: 'rejected', rejectionReason: 'Took it as a discount' } });
      tx.refund.findFirst.mockResolvedValueOnce(refund({ status: 'processed' }));
      await expect(service.reject(TENANT_ID, 'refund-1', 'x', manager)).rejects.toThrow(/already processed/);
    });

    it('nothing is paid out before a manager approves', async () => {
      tx.refund.findFirst.mockResolvedValueOnce(refund());
      await expect(service.payOut(TENANT_ID, 'refund-1', desk)).rejects.toThrow(/has to approve/);
    });

    it("pays out as a negative payment — cash from the hander's own drawer", async () => {
      tx.refund.findFirst.mockResolvedValueOnce(refund({ status: 'approved' }));
      await service.payOut(TENANT_ID, 'refund-1', desk);
      const payment = tx.payment.create.mock.calls[0][0].data;
      expect(payment).toMatchObject({ folioId: FOLIO_ID, method: 'cash', currency: 'NGN', shiftId: 'shift-1', recordedBy: 'desk-1' });
      expect(payment.amount.toFixed(2)).toBe('-15000.00');
      expect(tx.shift.findFirst).toHaveBeenCalledWith({ where: { branchId: BRANCH_ID, agentId: 'desk-1', closedAt: null } });
      expect(tx.refund.update).toHaveBeenCalledWith({
        where: { id: 'refund-1' },
        data: { status: 'processed', processedAt: expect.any(Date), processedBy: 'desk-1', refundPaymentId: 'pay-out-1' },
      });
      expect(webhookEvents.paymentRecorded).toHaveBeenCalledWith(tx, { tenantId: TENANT_ID, branchId: BRANCH_ID, type: 'refund.paid', paymentId: 'pay-out-1', refundId: 'refund-1' });
    });

    it('cash can’t leave a drawer that isn’t open', async () => {
      tx.refund.findFirst.mockResolvedValueOnce(refund({ status: 'approved' }));
      tx.shift.findFirst.mockResolvedValueOnce(null);
      await expect(service.payOut(TENANT_ID, 'refund-1', desk)).rejects.toThrow(/Open a shift/);
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('a card refund touches no drawer', async () => {
      tx.refund.findFirst.mockResolvedValueOnce(refund({ status: 'approved', method: 'card' }));
      await service.payOut(TENANT_ID, 'refund-1', desk);
      expect(tx.shift.findFirst).not.toHaveBeenCalled();
      expect(tx.payment.create.mock.calls[0][0].data.shiftId).toBeUndefined();
    });

    it('never pays out more than the credit left — the guest must not end up owing', async () => {
      tx.refund.findFirst.mockResolvedValueOnce(refund({ status: 'approved' }));
      totals.mockResolvedValueOnce({ balanceDue: d(-1000) });
      await expect(service.payOut(TENANT_ID, 'refund-1', desk)).rejects.toThrow(/only 1000.00 in credit/);
      expect(tx.payment.create).not.toHaveBeenCalled();
    });
  });
});
