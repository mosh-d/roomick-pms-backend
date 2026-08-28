import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { gunzipSync } from 'zlib';
import { PrismaService } from '../../prisma/prisma.service';
import { BackupsService } from './backups.service';
import { BACKUP_STORAGE_ADAPTER } from './storage/backup-storage.interface';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function makeTx() {
  // A handful of real tenant-scoped model accessors — enough to prove the
  // dynamic DMMF-driven loop actually calls through to real Prisma
  // delegates, not that every one of the 37 is individually exercised here.
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (target, prop: string) => {
      if (!(prop in target)) {
        target[prop] = { findMany: jest.fn().mockResolvedValue([]) };
      }
      return target[prop];
    },
  };
  return new Proxy({}, handler) as Record<string, { findMany: jest.Mock }>;
}

describe('BackupsService', () => {
  let service: BackupsService;
  let tx: ReturnType<typeof makeTx>;
  let storage: { write: jest.Mock; read: jest.Mock };
  let prisma: { backupRecord: { create: jest.Mock; update: jest.Mock; findFirst: jest.Mock }; tenant: { findMany: jest.Mock }; withTenant: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    storage = { write: jest.fn().mockResolvedValue('file:///tmp/roomick-backups/test.json.gz'), read: jest.fn() };
    prisma = {
      backupRecord: {
        create: jest.fn().mockResolvedValue({ id: 'backup-1' }),
        update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'backup-1', ...data })),
        findFirst: jest.fn(),
      },
      tenant: { findMany: jest.fn().mockResolvedValue([]) },
      withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BackupsService,
        { provide: PrismaService, useValue: prisma },
        { provide: BACKUP_STORAGE_ADAPTER, useValue: storage },
      ],
    }).compile();
    service = moduleRef.get(BackupsService);
  });

  describe('runTenantBackup', () => {
    it('queries every tenant-scoped model, gzips the result, and marks the record completed', async () => {
      const result = await service.runTenantBackup(TENANT_ID);
      expect(prisma.backupRecord.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: TENANT_ID, status: 'running' }) }));
      expect(prisma.withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
      // A representative sample of real tenant-scoped models must have been queried.
      expect(tx.reservation.findMany).toHaveBeenCalled();
      expect(tx.folio.findMany).toHaveBeenCalled();
      expect(tx.payment.findMany).toHaveBeenCalled();
      expect(storage.write).toHaveBeenCalledWith(expect.stringContaining(TENANT_ID), expect.any(Buffer));
      expect(prisma.backupRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'completed', storageUrl: expect.any(String) }) }),
      );
      expect(result.status).toBe('completed');
    });

    it('never queries the excluded meta tables (UserEmailIndex, BackupRecord)', async () => {
      await service.runTenantBackup(TENANT_ID);
      expect(Object.prototype.hasOwnProperty.call(tx, 'userEmailIndex')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(tx, 'backupRecord')).toBe(false);
    });

    it('writes gzipped, valid JSON — decompresses back to the queried rows', async () => {
      tx.reservation.findMany.mockResolvedValue([{ id: 'res-1' }]);
      await service.runTenantBackup(TENANT_ID);
      const written = storage.write.mock.calls[0][1] as Buffer;
      const decompressed = JSON.parse(gunzipSync(written).toString('utf-8')) as Record<string, unknown[]>;
      expect(decompressed.Reservation).toEqual([{ id: 'res-1' }]);
    });

    it('marks the record failed, not thrown, when the export itself errors', async () => {
      prisma.withTenant.mockRejectedValueOnce(new Error('connection lost'));
      const result = await service.runTenantBackup(TENANT_ID);
      expect(result.status).toBe('failed');
      expect(prisma.backupRecord.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }));
    });
  });

  describe('runBackupForAllTenants', () => {
    it('only backs up trial/active tenants, and one failure does not stop the rest', async () => {
      prisma.tenant.findMany.mockResolvedValue([{ id: 'tenant-a', subdomain: 'a' }, { id: 'tenant-b', subdomain: 'b' }]);
      const spy = jest.spyOn(service, 'runTenantBackup').mockResolvedValueOnce({ id: 'x', status: 'failed' }).mockResolvedValueOnce({ id: 'y', status: 'completed' });
      await service.runBackupForAllTenants();
      expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: { in: ['trial', 'active'] } } }));
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('verifyBackup', () => {
    it('reports ok:false when the backup record has no stored file', async () => {
      prisma.backupRecord.findFirst.mockResolvedValue({ id: 'backup-1', storageUrl: null });
      const result = await service.verifyBackup('backup-1');
      expect(result.ok).toBe(false);
    });

    it('reports ok:false when the stored file is missing an expected table', async () => {
      prisma.backupRecord.findFirst.mockResolvedValue({ id: 'backup-1', storageUrl: 'file:///x.json.gz' });
      const { gzipSync } = jest.requireActual('zlib');
      storage.read.mockResolvedValue(gzipSync(Buffer.from(JSON.stringify({ Reservation: [] }), 'utf-8')));
      const result = await service.verifyBackup('backup-1');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('missing');
    });

    it('reports ok:true with row counts when the file has every expected table', async () => {
      prisma.backupRecord.findFirst.mockResolvedValue({ id: 'backup-1', storageUrl: 'file:///x.json.gz' });
      const { gzipSync } = jest.requireActual('zlib');
      // Build a snapshot with exactly the model set BackupsService itself expects, from the DMMF, so this test
      // stays correct if the schema grows a new tenant-scoped model rather than hand-maintaining a duplicate list.
      const expectedModels = Prisma.dmmf.datamodel.models
        .filter((m) => m.fields.some((f) => f.name === 'tenantId') && !['UserEmailIndex', 'BackupRecord'].includes(m.name))
        .map((m) => m.name);
      const snapshot = Object.fromEntries(expectedModels.map((name) => [name, []]));
      storage.read.mockResolvedValue(gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf-8')));
      const result = await service.verifyBackup('backup-1');
      expect(result.ok).toBe(true);
      expect(Object.keys(result.modelCounts ?? {})).toHaveLength(expectedModels.length);
    });
  });
});
