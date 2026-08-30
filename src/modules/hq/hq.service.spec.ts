import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FoliosService } from '../folios/folios.service';
import { ReportsService } from '../reports/reports.service';
import { HqService } from './hq.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('HqService', () => {
  let service: HqService;
  let prisma: { withTenant: jest.Mock };
  let foliosService: { listFolios: jest.Mock };
  let reportsService: { getOccupancy: jest.Mock; getAdr: jest.Mock; getRevpar: jest.Mock; getRevenue: jest.Mock };
  let tx: { brand: { findMany: jest.Mock }; branch: { findMany: jest.Mock }; room: { count: jest.Mock }; reservation: { count: jest.Mock } };

  beforeEach(async () => {
    tx = {
      brand: { findMany: jest.fn().mockResolvedValue([{ id: 'brand-1', name: 'Acme Hotels' }]) },
      branch: { findMany: jest.fn().mockResolvedValue([]) },
      room: { count: jest.fn().mockResolvedValue(0) },
      reservation: { count: jest.fn().mockResolvedValue(0) },
    };
    prisma = { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) };
    foliosService = { listFolios: jest.fn().mockResolvedValue([]) };
    reportsService = { getOccupancy: jest.fn(), getAdr: jest.fn(), getRevpar: jest.fn(), getRevenue: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        HqService,
        { provide: PrismaService, useValue: prisma },
        { provide: FoliosService, useValue: foliosService },
        { provide: ReportsService, useValue: reportsService },
      ],
    }).compile();
    service = moduleRef.get(HqService);
  });

  describe('getPortfolio', () => {
    it('computes occupancyPctNow from occupied/total rooms, and 0 (not NaN) for a branch with zero rooms', async () => {
      tx.branch.findMany.mockResolvedValue([{ id: 'branch-1', name: 'Main', brandId: 'brand-1', currency: 'NGN' }]);
      tx.room.count.mockResolvedValueOnce(10).mockResolvedValueOnce(4); // total, then occupied
      const result = await service.getPortfolio(TENANT_ID);
      expect(result.branches[0].occupancyPctNow).toBe(40);
    });

    it('reports 0% (not NaN) for a branch with zero rooms', async () => {
      tx.branch.findMany.mockResolvedValue([{ id: 'branch-1', name: 'Empty', brandId: 'brand-1', currency: 'NGN' }]);
      tx.room.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      const result = await service.getPortfolio(TENANT_ID);
      expect(result.branches[0].occupancyPctNow).toBe(0);
    });

    it('sums outstandingBalance from FoliosService.listFolios, reusing its real balance computation', async () => {
      tx.branch.findMany.mockResolvedValue([{ id: 'branch-1', name: 'Main', brandId: 'brand-1', currency: 'NGN' }]);
      foliosService.listFolios.mockResolvedValue([{ balanceDue: new Prisma.Decimal('1000.50') }, { balanceDue: new Prisma.Decimal('499.50') }]);
      const result = await service.getPortfolio(TENANT_ID);
      expect(foliosService.listFolios).toHaveBeenCalledWith(TENANT_ID, 'branch-1', 'outstanding');
      expect(result.branches[0].outstandingBalance).toBe('1500.00');
    });

    it('maps each branch to its own brand name, falling back to "Unknown" for an orphaned brandId', async () => {
      tx.branch.findMany.mockResolvedValue([
        { id: 'branch-1', name: 'Known Brand Branch', brandId: 'brand-1', currency: 'NGN' },
        { id: 'branch-2', name: 'Orphan Branch', brandId: 'brand-missing', currency: 'NGN' },
      ]);
      const result = await service.getPortfolio(TENANT_ID);
      expect(result.branches.find((b) => b.branchId === 'branch-1')?.brandName).toBe('Acme Hotels');
      expect(result.branches.find((b) => b.branchId === 'branch-2')?.brandName).toBe('Unknown');
    });
  });

  describe('getCrossPropertyReport', () => {
    function branches(currencies: string[]) {
      return currencies.map((currency, i) => ({ id: `branch-${i}`, name: `Branch ${i}`, currency }));
    }

    it('blends occupancy across branches even with mixed currencies — room-nights carry no currency', async () => {
      tx.branch.findMany.mockResolvedValue(branches(['NGN', 'USD']));
      reportsService.getOccupancy
        .mockResolvedValueOnce({ summary: { roomNightsAvailable: 100, roomNightsSold: 40, occupancyPct: 40 } })
        .mockResolvedValueOnce({ summary: { roomNightsAvailable: 50, roomNightsSold: 30, occupancyPct: 60 } });
      const result = await service.getCrossPropertyReport(TENANT_ID, 'occupancy', { from: '2026-08-01', to: '2026-08-02' });
      expect(result.mixedCurrencies).toBe(true);
      expect(result.blendedTotal).toEqual({ roomNightsAvailable: 150, roomNightsSold: 70, occupancyPct: Math.round((70 / 150) * 1000) / 10 });
    });

    it('blends ADR when every branch shares the same currency', async () => {
      tx.branch.findMany.mockResolvedValue(branches(['NGN', 'NGN']));
      reportsService.getAdr
        .mockResolvedValueOnce({ summary: { roomNightsSold: 10, roomRevenue: '300000.00', adr: '30000.00' } })
        .mockResolvedValueOnce({ summary: { roomNightsSold: 5, roomRevenue: '200000.00', adr: '40000.00' } });
      const result = await service.getCrossPropertyReport(TENANT_ID, 'adr', { from: '2026-08-01', to: '2026-08-02' });
      expect(result.blendedTotal).toEqual({ roomNightsSold: 15, roomRevenue: '500000.00', adr: '33333.33' });
    });

    it('refuses to blend revenue-denominated totals across mixed currencies — returns null, not a fabricated sum', async () => {
      tx.branch.findMany.mockResolvedValue(branches(['NGN', 'USD']));
      reportsService.getRevenue
        .mockResolvedValueOnce({ summary: { totalRevenue: '500000.00' } })
        .mockResolvedValueOnce({ summary: { totalRevenue: '1200.00' } });
      const result = await service.getCrossPropertyReport(TENANT_ID, 'revenue', { from: '2026-08-01', to: '2026-08-02' });
      expect(result.mixedCurrencies).toBe(true);
      expect(result.blendedTotal).toBeNull();
      // The per-branch rows are still returned — only the fabricated cross-currency total is withheld.
      expect(result.rows).toHaveLength(2);
    });

    it('respects an explicit branchIds filter, scoping the query to only those branches', async () => {
      tx.branch.findMany.mockResolvedValue(branches(['NGN']));
      reportsService.getRevpar.mockResolvedValue({ summary: { roomNightsAvailable: 10, roomRevenue: '100.00', revpar: '10.00' } });
      await service.getCrossPropertyReport(TENANT_ID, 'revpar', { from: '2026-08-01', to: '2026-08-02' }, ['branch-0']);
      expect(tx.branch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['branch-0'] } }) }));
    });
  });
});
