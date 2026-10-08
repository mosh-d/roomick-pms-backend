import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogsService } from './audit-logs.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function makeTx() {
  return {
    auditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
}

const owner = { sub: 'owner-1', tenantId: TENANT_ID, email: 'o@x.t', roles: [{ branchId: null, role: 'owner' }], tokenType: 'access' as const };
const branchManager = { sub: 'mgr-1', tenantId: TENANT_ID, email: 'm@x.t', roles: [{ branchId: BRANCH_ID, role: 'manager' }], tokenType: 'access' as const };

describe('AuditLogsService', () => {
  let service: AuditLogsService;
  let tx: ReturnType<typeof makeTx>;

  beforeEach(async () => {
    tx = makeTx();
    const moduleRef = await Test.createTestingModule({
      providers: [AuditLogsService, { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } }],
    }).compile();
    service = moduleRef.get(AuditLogsService);
  });

  it('defaults to page 1, limit 50, no filters', async () => {
    await service.listAuditLogs(TENANT_ID, {}, owner);
    expect(tx.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {}, skip: 0, take: 50 }));
  });

  it('filters by branchId', async () => {
    await service.listAuditLogs(TENANT_ID, { branchId: BRANCH_ID }, owner);
    expect(tx.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { branchId: BRANCH_ID } }));
  });

  it('filters by userId', async () => {
    await service.listAuditLogs(TENANT_ID, { userId: USER_ID }, owner);
    expect(tx.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER_ID } }));
  });

  it('filters by action as a case-insensitive substring match', async () => {
    await service.listAuditLogs(TENANT_ID, { action: 'check_in' }, owner);
    expect(tx.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { action: { contains: 'check_in', mode: 'insensitive' } } }),
    );
  });

  it('a from/to range is inclusive of the entire "to" day', async () => {
    await service.listAuditLogs(TENANT_ID, { from: '2026-08-01', to: '2026-08-31' }, owner);
    expect(tx.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { timestamp: { gte: new Date('2026-08-01T00:00:00.000Z'), lt: new Date('2026-09-01T00:00:00.000Z') } },
      }),
    );
  });

  it('applies page/limit as skip/take', async () => {
    await service.listAuditLogs(TENANT_ID, { page: 3, limit: 10 }, owner);
    expect(tx.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
  });

  it('stringifies the BigInt id so the response is JSON-serializable', async () => {
    tx.auditLog.findMany.mockResolvedValue([{ id: 123n, action: 'reservation.check_in', user: null }]);
    const result = await service.listAuditLogs(TENANT_ID, {}, owner);
    expect(result.rows[0].id).toBe('123');
    expect(typeof result.rows[0].id).toBe('string');
  });

  it('a manager of one property reads that property and the organisation-wide entries — never another property', async () => {
    await service.listAuditLogs(TENANT_ID, {}, branchManager);
    const where = (tx.auditLog.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.OR).toEqual([{ branchId: { in: [BRANCH_ID] } }, { branchId: null }]);
    await expect(service.listAuditLogs(TENANT_ID, { branchId: '99999999-9999-4999-8999-999999999999' }, branchManager)).rejects.toThrow(/properties you manage/);
  });

  it('the owner reads every property', async () => {
    await service.listAuditLogs(TENANT_ID, {}, owner);
    const where = (tx.auditLog.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where).not.toHaveProperty('OR');
  });

  it('returns the total count alongside the page of rows', async () => {
    tx.auditLog.count.mockResolvedValue(137);
    const result = await service.listAuditLogs(TENANT_ID, {}, owner);
    expect(result.total).toBe(137);
  });
});
