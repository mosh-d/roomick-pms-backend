import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { FoliosService } from '../folios/folios.service';
import { AlertsService } from './alerts.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';

// Africa/Lagos (UTC+1, no DST) — check-in 14:00, check-out 11:00, matching the schema's own defaults.
function branch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: BRANCH_ID,
    timezone: 'Africa/Lagos',
    checkInTime: new Date('1970-01-01T14:00:00.000Z'),
    checkOutTime: new Date('1970-01-01T11:00:00.000Z'),
    ...overrides,
  };
}

function makeTx() {
  return {
    branch: { findFirst: jest.fn().mockResolvedValue(branch()) },
    reservation: {
      findMany: jest.fn().mockImplementation(({ where }: { where: { status: string } }) =>
        Promise.resolve(where.status === 'confirmed' ? [] : []),
      ),
    },
  };
}

describe('AlertsService', () => {
  let service: AlertsService;
  let tx: ReturnType<typeof makeTx>;
  let propertyService: { assertBranch: jest.Mock };
  let foliosService: { listFolios: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    propertyService = { assertBranch: jest.fn().mockImplementation((_tx, id) => tx.branch.findFirst({ where: { id } })) };
    foliosService = { listFolios: jest.fn().mockResolvedValue([]) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AlertsService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: PropertyService, useValue: propertyService },
        { provide: FoliosService, useValue: foliosService },
      ],
    }).compile();
    service = moduleRef.get(AlertsService);
  });

  it('reports zero alerts when nothing is missed/overdue', async () => {
    const result = await service.getAlerts(TENANT_ID, BRANCH_ID);
    expect(result).toEqual({ missedCheckIns: [], overdueCheckouts: [], overdueBalances: [], total: 0 });
  });

  it('flags a confirmed reservation whose check-in date is strictly in the past, regardless of clock time', async () => {
    const reservation = { id: 'r1', checkInDate: new Date('2020-01-01T00:00:00.000Z'), checkOutDate: new Date('2020-01-03T00:00:00.000Z') };
    tx.reservation.findMany = jest.fn().mockImplementation(({ where }) =>
      Promise.resolve(where.status === 'confirmed' ? [reservation] : []),
    );
    const result = await service.getAlerts(TENANT_ID, BRANCH_ID);
    expect(result.missedCheckIns).toEqual([reservation]);
    expect(result.total).toBe(1);
  });

  it('does NOT flag a confirmed reservation checking in today before the branch check-in cutoff has passed', async () => {
    const today = new Date();
    tx.reservation.findMany = jest.fn().mockImplementation(({ where }) =>
      Promise.resolve(where.status === 'confirmed' ? [{ id: 'r1', checkInDate: today, checkOutDate: today }] : []),
    );
    // The service compares against `new Date()` internally — this test only
    // holds if run before 14:00 WAT; assert the branch of behavior directly
    // via a controlled "past cutoff" branch instead, for determinism.
    const branchAlreadyPastCutoff = branch({ checkInTime: new Date('1970-01-01T00:00:00.000Z') });
    tx.branch.findFirst = jest.fn().mockResolvedValue(branchAlreadyPastCutoff);
    const resultPast = await service.getAlerts(TENANT_ID, BRANCH_ID);
    expect(resultPast.missedCheckIns).toHaveLength(1);

    const branchNotYetPastCutoff = branch({ checkInTime: new Date('1970-01-01T23:59:59.000Z') });
    tx.branch.findFirst = jest.fn().mockResolvedValue(branchNotYetPastCutoff);
    const resultFuture = await service.getAlerts(TENANT_ID, BRANCH_ID);
    expect(resultFuture.missedCheckIns).toHaveLength(0);
  });

  it('flags a checked-in reservation whose check-out date has passed the branch checkout cutoff', async () => {
    const reservation = { id: 'r2', checkInDate: new Date('2020-01-01T00:00:00.000Z'), checkOutDate: new Date('2020-01-02T00:00:00.000Z') };
    tx.reservation.findMany = jest.fn().mockImplementation(({ where }) =>
      Promise.resolve(where.status === 'checked_in' ? [reservation] : []),
    );
    const result = await service.getAlerts(TENANT_ID, BRANCH_ID);
    expect(result.overdueCheckouts).toEqual([reservation]);
  });

  it('delegates overdue balances to FoliosService.listFolios("overdue") instead of re-deriving balance logic', async () => {
    const overdueFolio = { id: 'f1', balanceDue: '5000.00' };
    foliosService.listFolios.mockResolvedValue([overdueFolio]);
    const result = await service.getAlerts(TENANT_ID, BRANCH_ID);
    expect(foliosService.listFolios).toHaveBeenCalledWith(TENANT_ID, BRANCH_ID, 'overdue');
    expect(result.overdueBalances).toEqual([overdueFolio]);
    expect(result.total).toBe(1);
  });

  it('sums all three categories into total', async () => {
    tx.reservation.findMany = jest.fn().mockImplementation(({ where }) =>
      Promise.resolve(
        where.status === 'confirmed'
          ? [{ id: 'm1', checkInDate: new Date('2020-01-01T00:00:00.000Z') }]
          : [{ id: 'o1', checkOutDate: new Date('2020-01-01T00:00:00.000Z') }],
      ),
    );
    foliosService.listFolios.mockResolvedValue([{ id: 'f1' }, { id: 'f2' }]);
    const result = await service.getAlerts(TENANT_ID, BRANCH_ID);
    expect(result.total).toBe(4);
  });
});
