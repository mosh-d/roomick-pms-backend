import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AccountStatusService } from '../../common/auth/account-status.service';
import { tenantModelInsertOrder } from '../../common/prisma/tenant-models';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { BrandModeInput } from './dto/configure-mode.dto';
import { TenantsService } from './tenants.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

jest.mock('bcrypt', () => ({ compare: jest.fn() }));

/** Every table the deletion touches, as it touches it — any model name answers with a stub, so the order is checked against the schema, not a hand-list. */
function deletionTx() {
  const touched: string[] = [];
  const tables = new Map<string, { deleteMany: jest.Mock; updateMany: jest.Mock }>();
  const target: Record<string, unknown> = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    userEmailIndex: { deleteMany: jest.fn().mockImplementation(() => { touched.push('userEmailIndex'); return Promise.resolve({ count: 1 }); }) },
    backupRecord: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    tenant: { delete: jest.fn().mockImplementation(() => { touched.push('tenant'); return Promise.resolve({}); }) },
  };
  const tx = new Proxy(target, {
    get(obj, prop: string) {
      if (prop in obj) return obj[prop];
      let table = tables.get(prop);
      if (!table) {
        table = {
          deleteMany: jest.fn().mockImplementation(() => { touched.push(prop); return Promise.resolve({ count: 0 }); }),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        };
        tables.set(prop, table);
      }
      return table;
    },
  });
  return { tx, touched, tables, target };
}

describe('TenantsService', () => {
  let service: TenantsService;
  let tx: {
    brand: { count: jest.Mock; create: jest.Mock };
    tenant: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    auditLog: { create: jest.Mock };
    user: { findFirst: jest.Mock; findMany: jest.Mock };
  };
  let transaction: jest.Mock;
  let accountStatus: { forget: jest.Mock };

  beforeEach(async () => {
    tx = {
      brand: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'brand-1', name: 'Demo Hotels' }),
      },
      tenant: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: TENANT_ID, groupName: 'Demo Hotels Group' }),
        update: jest.fn().mockResolvedValue({ id: TENANT_ID, brandMode: 'single' }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: USER_ID, passwordHash: 'owner-hash', deletedAt: null }),
        findMany: jest.fn().mockResolvedValue([{ id: USER_ID }, { id: 'staff-2' }]),
      },
    };
    transaction = jest.fn();
    accountStatus = { forget: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantsService,
        {
          provide: PrismaService,
          useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)), $transaction: transaction },
        },
        { provide: AccountStatusService, useValue: accountStatus },
      ],
    }).compile();

    service = moduleRef.get(TenantsService);
  });

  describe('deleteOrganization', () => {
    it('needs the owner’s own password — a wrong one deletes nothing', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.deleteOrganizationAsOwner(TENANT_ID, USER_ID, 'wrong')).rejects.toThrow(UnauthorizedException);
      expect(transaction).not.toHaveBeenCalled();
    });

    it('removes every tenant table children-first, the email index and the tenant row, in one transaction', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      const { tx: dtx, touched, target } = deletionTx();
      transaction.mockImplementation((fn: (x: unknown) => unknown) => fn(dtx));
      await service.deleteOrganizationAsOwner(TENANT_ID, USER_ID, 'Str0ngPass!1');

      expect(transaction).toHaveBeenCalledTimes(1);
      expect((target.$executeRaw as jest.Mock).mock.calls[0][0].join('?')).toContain("set_config('app.tenant_id'");
      const expected = [...tenantModelInsertOrder()].reverse().map((meta) => meta.accessor);
      expect(touched).toEqual([...expected, 'userEmailIndex', 'tenant']);
      // Children before parents: a bill's lines go before the bill, the bill before the stay, the stay before the guest.
      expect(touched.indexOf('lineItem')).toBeLessThan(touched.indexOf('folio'));
      expect(touched.indexOf('folio')).toBeLessThan(touched.indexOf('reservation'));
      expect(touched.indexOf('reservation')).toBeLessThan(touched.indexOf('guestProfile'));
      expect(touched.indexOf('user')).toBeLessThan(touched.indexOf('tenant'));
      expect((target.backupRecord as { updateMany: jest.Mock }).updateMany).toHaveBeenCalledWith({ where: { tenantId: TENANT_ID }, data: { tenantId: null } });
      // Everyone's access tokens stop working now, not in fifteen minutes.
      expect(accountStatus.forget).toHaveBeenCalledWith(USER_ID);
      expect(accountStatus.forget).toHaveBeenCalledWith('staff-2');
    });

    it('a wrong password forgets nobody', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.deleteOrganizationAsOwner(TENANT_ID, USER_ID, 'wrong')).rejects.toThrow(UnauthorizedException);
      expect(accountStatus.forget).not.toHaveBeenCalled();
    });

    it('cuts the links that close a cycle before deleting — a stay’s master bill points at a bill whose stay points back', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      const { tx: dtx, tables } = deletionTx();
      transaction.mockImplementation((fn: (x: unknown) => unknown) => fn(dtx));
      await service.deleteOrganization(TENANT_ID);
      const deferred = tenantModelInsertOrder().filter((meta) => meta.deferred.length > 0);
      expect(deferred.length).toBeGreaterThan(0);
      for (const meta of deferred) {
        for (const relation of meta.deferred) {
          expect(tables.get(meta.accessor)!.updateMany).toHaveBeenCalledWith({ where: { tenantId: TENANT_ID }, data: Object.fromEntries(relation.fieldNames.map((f) => [f, null])) });
        }
      }
    });
  });

  it('single mode creates the head brand (defaults to groupName)', async () => {
    const result = await service.configureMode(TENANT_ID, { mode: BrandModeInput.single }, USER_ID);

    expect(tx.brand.create).toHaveBeenCalledWith({
      data: { tenantId: TENANT_ID, name: 'Demo Hotels Group' },
    });
    expect(tx.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { brandMode: 'single' },
    });
    expect(result.brand).not.toBeNull();
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it('multi mode also creates the head brand (not just single)', async () => {
    const result = await service.configureMode(TENANT_ID, { mode: BrandModeInput.multi }, USER_ID);
    expect(tx.brand.create).toHaveBeenCalledWith({
      data: { tenantId: TENANT_ID, name: 'Demo Hotels Group' },
    });
    expect(result.brand).not.toBeNull();
  });

  it('is immutable once a brand exists (spec: brandMode immutable after first brand)', async () => {
    tx.brand.count.mockResolvedValue(1);
    await expect(
      service.configureMode(TENANT_ID, { mode: BrandModeInput.multi }, USER_ID),
    ).rejects.toThrow(ConflictException);
    expect(tx.tenant.update).not.toHaveBeenCalled();
  });
});
