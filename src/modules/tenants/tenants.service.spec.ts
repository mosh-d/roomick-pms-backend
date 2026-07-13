import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { BrandModeInput } from './dto/configure-mode.dto';
import { TenantsService } from './tenants.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

describe('TenantsService', () => {
  let service: TenantsService;
  let tx: {
    brand: { count: jest.Mock; create: jest.Mock };
    tenant: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    auditLog: { create: jest.Mock };
  };

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
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantsService,
        {
          provide: PrismaService,
          useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) },
        },
      ],
    }).compile();

    service = moduleRef.get(TenantsService);
  });

  it('single mode auto-creates the hidden brand (defaults to groupName)', async () => {
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

  it('multi mode creates no brand', async () => {
    const result = await service.configureMode(TENANT_ID, { mode: BrandModeInput.multi }, USER_ID);
    expect(tx.brand.create).not.toHaveBeenCalled();
    expect(result.brand).toBeNull();
  });

  it('is immutable once a brand exists (spec: brandMode immutable after first brand)', async () => {
    tx.brand.count.mockResolvedValue(1);
    await expect(
      service.configureMode(TENANT_ID, { mode: BrandModeInput.multi }, USER_ID),
    ).rejects.toThrow(ConflictException);
    expect(tx.tenant.update).not.toHaveBeenCalled();
  });
});
