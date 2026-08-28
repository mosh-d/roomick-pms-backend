import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { gunzipSync, gzipSync } from 'zlib';
import { PrismaService } from '../../prisma/prisma.service';
import { BackupsService } from './backups.service';
import { BACKUP_STORAGE_ADAPTER } from './storage/backup-storage.interface';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

type FakeDelegate = { findMany: jest.Mock; createMany: jest.Mock; deleteMany: jest.Mock; count: jest.Mock };

function makeTx() {
  // A handful of real tenant-scoped model accessors — enough to prove the
  // dynamic DMMF-driven loop actually calls through to real Prisma
  // delegates, not that every one of the 37 is individually exercised here.
  // `count` defaults to reading back `createMany`'s own last call length —
  // a stand-in for "the DB actually has what we just inserted" so the
  // restore-drill's real-count verification has something honest to read,
  // without a real Postgres in this test.
  const handler: ProxyHandler<Record<string, FakeDelegate>> = {
    get: (target, prop: string) => {
      if (!(prop in target)) {
        const delegate: FakeDelegate = {
          findMany: jest.fn().mockResolvedValue([]),
          createMany: jest.fn().mockResolvedValue({ count: 0 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          count: jest.fn().mockImplementation(() => {
            const lastCall = delegate.createMany.mock.calls.at(-1) as [{ data: unknown[] }] | undefined;
            return Promise.resolve(lastCall ? lastCall[0].data.length : 0);
          }),
        };
        target[prop] = delegate;
      }
      return target[prop];
    },
  };
  return new Proxy({}, handler);
}

describe('BackupsService', () => {
  let service: BackupsService;
  let tx: ReturnType<typeof makeTx>;
  let storage: { write: jest.Mock; read: jest.Mock };
  let prisma: {
    backupRecord: { create: jest.Mock; update: jest.Mock; findFirst: jest.Mock };
    tenant: { findMany: jest.Mock; create: jest.Mock; delete: jest.Mock };
    withTenant: jest.Mock;
  };

  beforeEach(async () => {
    tx = makeTx();
    storage = { write: jest.fn().mockResolvedValue('file:///tmp/roomick-backups/test.json.gz'), read: jest.fn() };
    prisma = {
      backupRecord: {
        create: jest.fn().mockResolvedValue({ id: 'backup-1' }),
        update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'backup-1', ...data })),
        findFirst: jest.fn(),
      },
      tenant: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'drill-tenant-1', ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
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

  describe('runRestoreDrill', () => {
    // A genuine dependency chain: Brand <- Branch <- RoomType, GuestProfile
    // standalone, and Reservation depending on all three, plus a User row
    // to exercise the global-unique-email rewrite. Every id below is the
    // ORIGINAL tenant's id — the whole point of the test is to prove none
    // of these survive into what gets written for the drill tenant.
    function seedSnapshot() {
      return {
        Brand: [{ id: 'brand-1', tenantId: TENANT_ID, name: 'Acme' }],
        Branch: [{ id: 'branch-1', tenantId: TENANT_ID, brandId: 'brand-1', name: 'Main' }],
        GuestProfile: [{ id: 'guest-1', tenantId: TENANT_ID, name: 'John' }],
        RoomType: [{ id: 'rt-1', tenantId: TENANT_ID, branchId: 'branch-1', name: 'Standard' }],
        Reservation: [{ id: 'res-1', tenantId: TENANT_ID, branchId: 'branch-1', guestId: 'guest-1', roomTypeId: 'rt-1', roomId: null, confirmationNumber: 'RES-1' }],
        User: [{ id: 'user-1', tenantId: TENANT_ID, email: 'staff@hotel.com', name: 'Staff' }],
      };
    }

    function mockStoredSnapshot(snapshot: Record<string, unknown[]>) {
      prisma.backupRecord.findFirst.mockResolvedValue({ id: 'backup-1', storageUrl: 'file:///x.json.gz' });
      storage.read.mockResolvedValue(gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf-8')));
    }

    it('ok:false when the backup record has no stored file', async () => {
      prisma.backupRecord.findFirst.mockResolvedValue({ id: 'backup-1', storageUrl: null });
      const result = await service.runRestoreDrill('backup-1');
      expect(result.ok).toBe(false);
      expect(prisma.tenant.create).not.toHaveBeenCalled();
    });

    it('creates a throwaway, already-expired, isDemo tenant as the restore target', async () => {
      mockStoredSnapshot(seedSnapshot());
      await service.runRestoreDrill('backup-1');
      expect(prisma.tenant.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isDemo: true, demoExpiresAt: expect.any(Date) }) }),
      );
    });

    it('rewrites tenantId on every restored row to the drill tenant, never the original', async () => {
      mockStoredSnapshot(seedSnapshot());
      await service.runRestoreDrill('backup-1');
      for (const model of ['brand', 'branch', 'guestProfile', 'roomType', 'reservation', 'user']) {
        const rows = tx[model].createMany.mock.calls[0][0].data as Array<{ tenantId: string }>;
        expect(rows.every((r) => r.tenantId === 'drill-tenant-1')).toBe(true);
      }
    });

    it('inserts parents before the children that reference them (Brand before Branch before Reservation)', async () => {
      mockStoredSnapshot(seedSnapshot());
      await service.runRestoreDrill('backup-1');
      const brandOrder = tx.brand.createMany.mock.invocationCallOrder[0];
      const branchOrder = tx.branch.createMany.mock.invocationCallOrder[0];
      const roomTypeOrder = tx.roomType.createMany.mock.invocationCallOrder[0];
      const reservationOrder = tx.reservation.createMany.mock.invocationCallOrder[0];
      expect(brandOrder).toBeLessThan(branchOrder);
      expect(branchOrder).toBeLessThan(roomTypeOrder);
      expect(roomTypeOrder).toBeLessThan(reservationOrder);
    });

    it("remaps a child's FK columns to its parent's NEW id, not the original", async () => {
      mockStoredSnapshot(seedSnapshot());
      await service.runRestoreDrill('backup-1');

      const newBranchId = (tx.branch.createMany.mock.calls[0][0].data as Array<{ id: string }>)[0].id;
      const newRoomTypeId = (tx.roomType.createMany.mock.calls[0][0].data as Array<{ id: string }>)[0].id;
      const newGuestId = (tx.guestProfile.createMany.mock.calls[0][0].data as Array<{ id: string }>)[0].id;
      const reservationRow = (tx.reservation.createMany.mock.calls[0][0].data as Array<Record<string, string>>)[0];

      expect(newBranchId).not.toBe('branch-1');
      expect(reservationRow.branchId).toBe(newBranchId);
      expect(reservationRow.roomTypeId).toBe(newRoomTypeId);
      expect(reservationRow.guestId).toBe(newGuestId);
      expect(reservationRow.id).not.toBe('res-1');
    });

    it('rewrites the globally-unique User.email off the row\'s own new id — never the original address', async () => {
      mockStoredSnapshot(seedSnapshot());
      await service.runRestoreDrill('backup-1');
      const userRow = (tx.user.createMany.mock.calls[0][0].data as Array<{ id: string; email: string }>)[0];
      expect(userRow.email).not.toBe('staff@hotel.com');
      expect(userRow.email).toBe(`restore-drill+${userRow.id}@invalid.local`);
    });

    it('reports ok:true with matching expected/restored counts on a clean run', async () => {
      mockStoredSnapshot(seedSnapshot());
      const result = await service.runRestoreDrill('backup-1');
      expect(result.ok).toBe(true);
      expect(result.modelCounts?.Reservation).toEqual({ expected: 1, restored: 1 });
      expect(result.mismatches).toBeUndefined();
    });

    it('deletes every populated model for the drill tenant, then the tenant itself', async () => {
      mockStoredSnapshot(seedSnapshot());
      await service.runRestoreDrill('backup-1');
      expect(tx.reservation.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'drill-tenant-1' } });
      expect(tx.brand.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'drill-tenant-1' } });
      expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: 'drill-tenant-1' } });
      // Children deleted before the parents they reference.
      const branchDelete = tx.branch.deleteMany.mock.invocationCallOrder[0];
      const brandDelete = tx.brand.deleteMany.mock.invocationCallOrder[0];
      expect(branchDelete).toBeLessThan(brandDelete);
    });

    it('flags a mismatch when the real post-insert count disagrees with what was sent', async () => {
      mockStoredSnapshot(seedSnapshot());
      tx.reservation.count.mockResolvedValue(0); // simulates a row that silently failed to persist
      const result = await service.runRestoreDrill('backup-1');
      expect(result.ok).toBe(false);
      expect(result.mismatches).toContain('Reservation');
      expect(result.modelCounts?.Reservation).toEqual({ expected: 1, restored: 0 });
    });

    it('still cleans up the throwaway tenant even when an insert fails partway through', async () => {
      mockStoredSnapshot(seedSnapshot());
      tx.reservation.createMany.mockRejectedValueOnce(new Error('constraint violation'));
      const result = await service.runRestoreDrill('backup-1');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('constraint violation');
      expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: 'drill-tenant-1' } });
    });
  });
});
