import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { CommsLogService } from '../comms-log/comms-log.service';
import { FoliosService } from '../folios/folios.service';
import { SUGGESTED_TIERS } from './loyalty-rules';
import { LoyaltyService } from './loyalty.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_BRANCH_ID = '99999999-9999-4999-8999-999999999999';
const GUEST_ID = '33333333-3333-4333-8333-333333333333';
const FOLIO_ID = '44444444-4444-4444-8444-444444444444';
const RESERVATION_ID = '55555555-5555-4555-8555-555555555555';
const ACTOR_ID = '66666666-6666-4666-8666-666666666666';

function actor(role = 'front_desk', branchId: string | null = BRANCH_ID): JwtPayload {
  return { sub: ACTOR_ID, tenantId: TENANT_ID, email: 'desk@example.com', roles: [{ branchId, role }], tokenType: 'access' };
}

const PROGRAM = {
  id: 'program-1',
  tenantId: TENANT_ID,
  isActive: true,
  currency: 'NGN',
  pointsPerUnit: new Prisma.Decimal('0.01'),
  pointValue: new Prisma.Decimal('1'),
  tiers: SUGGESTED_TIERS,
  updatedAt: new Date(),
  updatedBy: null,
};
const GUEST = { id: GUEST_ID, name: 'Kemi Adeyemi', loyaltyPoints: 1000, loyaltyTier: 'Silver', loyaltyEnrolledAt: new Date('2026-01-01'), deletedAt: null };
const STAY = { id: RESERVATION_ID, tenantId: TENANT_ID, branchId: BRANCH_ID, guestId: GUEST_ID, confirmationNumber: 'RES-2026-00042' };

type Data = { data: Record<string, unknown> };

describe('LoyaltyService', () => {
  let service: LoyaltyService;
  let tx: ReturnType<typeof makeTx>;
  let folios: { recordLoyaltyPaymentInTx: jest.Mock };
  let comms: { logAutomatedInTx: jest.Mock };

  function makeTx() {
    return {
      $queryRaw: jest.fn().mockResolvedValue([]),
      loyaltyProgram: {
        findUnique: jest.fn().mockResolvedValue(PROGRAM),
        upsert: jest.fn().mockImplementation(({ create }: { create: Record<string, unknown> }) => Promise.resolve({ ...PROGRAM, ...create })),
      },
      loyaltyTransaction: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { points: 1000 } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      branch: { findFirst: jest.fn().mockResolvedValue({ currency: 'NGN' }), findMany: jest.fn().mockResolvedValue([{ currency: 'NGN' }]) },
      lineItem: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal('32000') } }) },
      guestProfile: { findFirst: jest.fn().mockResolvedValue(GUEST), findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
      folio: { findFirst: jest.fn().mockResolvedValue({ id: FOLIO_ID, branchId: BRANCH_ID, guestId: GUEST_ID }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
  }

  beforeEach(async () => {
    tx = makeTx();
    folios = { recordLoyaltyPaymentInTx: jest.fn().mockResolvedValue({ id: 'payment-1' }) };
    comms = { logAutomatedInTx: jest.fn().mockResolvedValue({}) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        LoyaltyService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: FoliosService, useValue: folios },
        { provide: CommsLogService, useValue: comms },
      ],
    }).compile();
    service = moduleRef.get(LoyaltyService);
  });

  const earn = () => service.earnForStayInTx(tx as never, STAY as never, ACTOR_ID);

  describe('earnForStayInTx', () => {
    it("earns on the stay's spend before tax, once, and moves the balance with it", async () => {
      const points = await earn();
      expect(points).toBe(320); // ₦32,000 × 0.01
      expect(tx.lineItem.aggregate).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ folio: { reservationId: RESERVATION_ID }, chargeType: { not: 'tax' } }) }));
      expect((tx.loyaltyTransaction.create.mock.calls[0] as [Data])[0].data).toMatchObject({ type: 'earn', points: 320, earnReservationId: RESERVATION_ID, branchId: BRANCH_ID });
      expect(tx.guestProfile.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ loyaltyPoints: { increment: 320 } }) }));
    });

    it('moves a member up a tier the moment they reach it, and tells them', async () => {
      tx.loyaltyTransaction.aggregate.mockResolvedValue({ _sum: { points: 1600 } }); // lifetime after this stay
      await earn();
      expect((tx.guestProfile.update.mock.calls[0] as [Data])[0].data.loyaltyTier).toBe('Gold');
      expect(comms.logAutomatedInTx).toHaveBeenCalledWith(tx, TENANT_ID, BRANCH_ID, expect.objectContaining({ subject: 'Welcome to Gold', trigger: 'loyalty_tier_upgrade' }));
    });

    it('earns nothing when the programme is off, in another currency, or the stay already earned', async () => {
      tx.loyaltyProgram.findUnique.mockResolvedValueOnce({ ...PROGRAM, isActive: false });
      expect(await earn()).toBe(0);
      tx.branch.findFirst.mockResolvedValueOnce({ currency: 'USD' });
      expect(await earn()).toBe(0);
      tx.loyaltyTransaction.findFirst.mockResolvedValueOnce({ id: 'earned-already' });
      expect(await earn()).toBe(0);
      expect(tx.loyaltyTransaction.create).not.toHaveBeenCalled();
    });

    it('earns nothing on a stay whose corrections cancelled its charges', async () => {
      tx.lineItem.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal('0') } });
      expect(await earn()).toBe(0);
      expect(tx.loyaltyTransaction.create).not.toHaveBeenCalled();
    });
  });

  describe('redeem', () => {
    it('turns points into a payment on the bill and takes them off, together', async () => {
      const result = await service.redeem(TENANT_ID, FOLIO_ID, 400, actor());
      const [, folioId, amount] = folios.recordLoyaltyPaymentInTx.mock.calls[0] as [unknown, string, Prisma.Decimal];
      expect(folioId).toBe(FOLIO_ID);
      expect(amount.toFixed(2)).toBe('400.00');
      expect((tx.loyaltyTransaction.create.mock.calls[0] as [Data])[0].data).toMatchObject({ type: 'redeem', points: -400, paymentId: 'payment-1' });
      expect(result).toMatchObject({ pointsRedeemed: 400, amount: '400.00', balance: 600 });
      expect(tx.$queryRaw).toHaveBeenCalled(); // the guest row lock
    });

    it("can't spend more points than the guest has", async () => {
      await expect(service.redeem(TENANT_ID, FOLIO_ID, 1001, actor())).rejects.toThrow(ConflictException);
      expect(folios.recordLoyaltyPaymentInTx).not.toHaveBeenCalled();
    });

    it("is refused at another branch's bill, and while the programme is off", async () => {
      await expect(service.redeem(TENANT_ID, FOLIO_ID, 100, actor('front_desk', OTHER_BRANCH_ID))).rejects.toThrow(ForbiddenException);
      tx.loyaltyProgram.findUnique.mockResolvedValueOnce({ ...PROGRAM, isActive: false });
      await expect(service.redeem(TENANT_ID, FOLIO_ID, 100, actor())).rejects.toThrow(ConflictException);
    });

    it('refuses points too few to be worth a cent', async () => {
      tx.loyaltyProgram.findUnique.mockResolvedValue({ ...PROGRAM, pointValue: new Prisma.Decimal('0.001') });
      await expect(service.redeem(TENANT_ID, FOLIO_ID, 3, actor())).rejects.toThrow(BadRequestException);
    });
  });

  describe('adjust', () => {
    it('adds points with the reason on the ledger', async () => {
      await service.adjust(TENANT_ID, GUEST_ID, { points: 250, reason: ' Goodwill — noisy room ' }, ACTOR_ID);
      expect((tx.loyaltyTransaction.create.mock.calls[0] as [Data])[0].data).toMatchObject({ type: 'adjust', points: 250, description: 'Goodwill — noisy room' });
    });

    it("can't take a balance below zero", async () => {
      await expect(service.adjust(TENANT_ID, GUEST_ID, { points: -1500, reason: 'Duplicate stay' }, ACTOR_ID)).rejects.toThrow(ConflictException);
      expect(tx.loyaltyTransaction.create).not.toHaveBeenCalled();
    });
  });

  describe('saveProgram', () => {
    const base = { isActive: true, currency: 'NGN', pointsPerUnit: 0.01, pointValue: 1, tiers: SUGGESTED_TIERS };

    it('refuses two tiers with the same name or the same threshold', async () => {
      await expect(service.saveProgram(TENANT_ID, { ...base, tiers: [...SUGGESTED_TIERS, { name: 'gold', threshold: 9000, benefits: [] }] }, ACTOR_ID)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.saveProgram(TENANT_ID, { ...base, tiers: [...SUGGESTED_TIERS, { name: 'Diamond', threshold: 5000, benefits: [] }] }, ACTOR_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("refuses a currency none of the branches charge in", async () => {
      await expect(service.saveProgram(TENANT_ID, { ...base, currency: 'USD' }, ACTOR_ID)).rejects.toThrow(/None of your branches charge in USD/);
    });

    it("moves every member to the tier their lifetime points reach under the new thresholds", async () => {
      tx.loyaltyTransaction.groupBy.mockResolvedValue([{ guestId: GUEST_ID, _sum: { points: 1600 } }]);
      tx.guestProfile.findMany.mockResolvedValue([{ id: GUEST_ID, loyaltyTier: 'Silver' }]);
      await service.saveProgram(TENANT_ID, base, ACTOR_ID);
      expect(tx.guestProfile.update).toHaveBeenCalledWith({ where: { id: GUEST_ID }, data: { loyaltyTier: 'Gold' } });
    });
  });
});
