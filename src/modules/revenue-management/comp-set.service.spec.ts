import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { RateResolverService } from '../rate-resolver/rate-resolver.service';
import { CompSetService, compareToMarket } from './comp-set.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const D = (v: string) => new Prisma.Decimal(v);

describe('compareToMarket', () => {
  it('flags a rate more than the threshold above the median, and ranks it among the market', () => {
    const result = compareToMarket(D('60000'), [D('50000'), D('48000'), D('55000')], 10);
    expect(result).toMatchObject({ marketMedian: '50000.00', marketLow: '48000.00', marketHigh: '55000.00', diffPct: 20, position: 'above_market', rank: 4, ofTotal: 4 });
  });

  it('uses the middle two for an even count, and flags a rate well below it', () => {
    const result = compareToMarket(D('40000'), [D('50000'), D('60000')], 10);
    expect(result).toMatchObject({ marketMedian: '55000.00', diffPct: -27.3, position: 'below_market', rank: 1, ofTotal: 3 });
  });

  it('calls a rate within the threshold in line', () => {
    expect(compareToMarket(D('52000'), [D('50000')], 10)).toMatchObject({ diffPct: 4, position: 'in_line', rank: 2 });
  });

  it('says so when no competitor rate was entered', () => {
    expect(compareToMarket(D('52000'), [], 10)).toEqual({ marketMedian: null, marketLow: null, marketHigh: null, diffPct: null, position: 'no_data', rank: null, ofTotal: null });
  });
});

describe('CompSetService', () => {
  let service: CompSetService;
  let tx: ReturnType<typeof makeTx>;
  let rateResolver: { resolveStay: jest.Mock };

  function makeTx() {
    return {
      competitor: {
        findFirst: jest.fn().mockResolvedValue({ id: 'comp-1', branchId: BRANCH_ID }),
        findMany: jest.fn().mockResolvedValue([
          { id: 'comp-1', name: 'Eko Signature' },
          { id: 'comp-2', name: 'Lagos Continental' },
        ]),
      },
      competitorRate: { upsert: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({ count: 3 }), findMany: jest.fn().mockResolvedValue([]) },
      roomType: { findFirst: jest.fn().mockResolvedValue({ id: 'rt-1', name: 'Standard' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
  }

  beforeEach(async () => {
    tx = makeTx();
    rateResolver = { resolveStay: jest.fn().mockResolvedValue({ perNight: [{ finalRate: '50000.00' }], subtotal: D('50000') }) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CompSetService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: PropertyService, useValue: { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, currency: 'NGN', timezone: 'Africa/Lagos' }) } },
        { provide: RateResolverService, useValue: rateResolver },
      ],
    }).compile();
    service = moduleRef.get(CompSetService);
  });

  describe('setRates', () => {
    const base = { competitorId: 'comp-1', roomTypeId: 'rt-1', fromDate: '2026-10-01', throughDate: '2026-10-03' };

    it('writes the rate for every night in the run, the last night included', async () => {
      const result = await service.setRates(TENANT_ID, BRANCH_ID, { ...base, rate: 52000 }, ACTOR_ID);
      expect(result).toEqual({ nights: 3 });
      expect(tx.competitorRate.upsert).toHaveBeenCalledTimes(3);
      const lastNight = (tx.competitorRate.upsert.mock.calls[2] as [{ where: { competitorId_roomTypeId_stayDate: { stayDate: Date } } }])[0];
      expect(lastNight.where.competitorId_roomTypeId_stayDate.stayDate.toISOString().slice(0, 10)).toBe('2026-10-03');
    });

    it('clears the run instead when asked', async () => {
      await service.setRates(TENANT_ID, BRANCH_ID, { ...base, clear: true }, ACTOR_ID);
      expect(tx.competitorRate.deleteMany).toHaveBeenCalled();
      expect(tx.competitorRate.upsert).not.toHaveBeenCalled();
    });

    it('refuses a run that ends before it starts, or no rate at all', async () => {
      await expect(service.setRates(TENANT_ID, BRANCH_ID, { ...base, throughDate: '2026-09-30', rate: 1 }, ACTOR_ID)).rejects.toThrow(BadRequestException);
      await expect(service.setRates(TENANT_ID, BRANCH_ID, base, ACTOR_ID)).rejects.toThrow(BadRequestException);
      expect(tx.competitorRate.upsert).not.toHaveBeenCalled();
    });
  });

  describe('getCompSet', () => {
    it("compares the Rate Resolver's one-night rate with each competitor's, night by night", async () => {
      tx.competitorRate.findMany.mockResolvedValue([
        { competitorId: 'comp-1', stayDate: new Date('2026-10-01T00:00:00.000Z'), rate: D('40000') },
        { competitorId: 'comp-2', stayDate: new Date('2026-10-01T00:00:00.000Z'), rate: D('42000') },
      ]);
      const result = await service.getCompSet(TENANT_ID, BRANCH_ID, { roomTypeId: 'rt-1', from: '2026-10-01', days: 2 });

      expect(rateResolver.resolveStay).toHaveBeenCalledTimes(2);
      const [, , , , checkIn, checkOut, , context] = rateResolver.resolveStay.mock.calls[0] as [unknown, unknown, unknown, unknown, Date, Date, unknown, { persistAudit: boolean }];
      expect([checkIn.toISOString().slice(0, 10), checkOut.toISOString().slice(0, 10)]).toEqual(['2026-10-01', '2026-10-02']);
      expect(context.persistAudit).toBe(false);

      expect(result.days[0]).toMatchObject({
        date: '2026-10-01',
        ourRate: '50000.00',
        competitorRates: [
          { competitorId: 'comp-1', rate: '40000.00' },
          { competitorId: 'comp-2', rate: '42000.00' },
        ],
        marketMedian: '41000.00',
        position: 'above_market',
      });
      expect(result.days[1]).toMatchObject({ date: '2026-10-02', position: 'no_data' });
      expect(result).toMatchObject({ currency: 'NGN', roomTypeName: 'Standard', thresholdPct: 10 });
    });
  });
});
